import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, readFile, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { AUTHORIZE_ANALYSIS, dockerCreateArguments, dockerVulnerableFixtureCreateArguments, IMAGE } from "../src/adapters/container-contract.ts";
import { COMPLETION_READER, OUTPUT_EXPORTER, receiveOutput } from "../src/adapters/container-export.ts";
import { OwnedProcess } from "../src/adapters/process.ts";
import { makeTestDirectory } from "./test-directory.ts";
test("container contract is digest-pinned and hardened", () => {
  const args = dockerCreateArguments({ input: "/tmp/input", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/official/bin:/usr/bin:/bin", pythonPath: "/official/python" });
  const joined = args.join(" ");
  for (const required of [IMAGE, "--platform linux/amd64", "--network none", "--read-only", "--user 1000:1000", "no-new-privileges=true", "--cap-drop ALL", "--pids-limit 128", "--memory 2g", "--cpus 2", "dst=/input,readonly", "dst=/tools/forge,readonly", "dst=/tools/solc,readonly", "create", "mapfile -t targets", "\"${targets[@]}\"", "host-authorized", "--entrypoint /usr/bin/env", " -i HOME=", "slither . --fail-pedantic --foundry-ignore-compile", "--skip test --skip script", "PYTHONPATH=/official/python", "CapEff", "pids.max", "memory.max", "cpu.max"]) {assert.match(joined, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));}
  assert.equal(joined.match(/--fail-pedantic/gu)?.length, 3);
  assert.equal(joined.includes("--fail-on pedantic"), false);
  assert.match(joined, /test ! -e \/var\/run\/docker\.sock/u);
  for (const forbidden of ["dst=/var/run/docker.sock", "--privileged", "--network host", ":latest"]) {assert.equal(joined.includes(forbidden), false);}
});

test("checkout paths are not used as writable Forge out/cache", () => {
  const joined = dockerCreateArguments({ input: "/tmp/input", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/usr/bin:/bin", pythonPath: "/official/python" }).join(" ");
  assert.match(joined, /FOUNDRY_OUT=\/work\/out/u); assert.doesNotMatch(joined, /FOUNDRY_OUT=\/input/u);
});


async function reapFixture(child: ChildProcess, closed: Promise<void>): Promise<void> {
  const failures: unknown[] = [];
  if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
    try {process.kill(-child.pid, "SIGKILL");} catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {failures.push(error);}
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([closed, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("fixture process did not close after exact-group reap")), 2_000);
    })]);
  } catch (error) {failures.push(error);} finally {
    clearTimeout(timer);
    child.stdout?.destroy(); child.stderr?.destroy();
  }
  if (failures.length > 0) {throw new AggregateError(failures, "fixture cleanup failed");}
}

const paths = { input: "/tmp/input", forge: "/tmp/forge", solc: "/tmp/solc", imagePath: "/usr/bin:/bin", pythonPath: "/official/python" };

for (const create of [dockerCreateArguments, dockerVulnerableFixtureCreateArguments]) {
  test(`${create.name}: generated shell parses and preserves private tmpfs and readonly binds`, async () => {
    const args = create(paths);
    assert.deepEqual(args.slice(0, 3), ["create", "--pull", "never"]);
    const parsed = await new OwnedProcess().run("/bin/bash", ["-n", "-c", args.at(-1)!], 3_000);
    assert.equal(parsed.exitCode, 0, parsed.stderr);
    assert.equal(parsed.timedOut, false);
    assert.deepEqual(args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]] : []), [
      "type=bind,src=/tmp/input,dst=/input,readonly", "type=bind,src=/tmp/forge,dst=/tools/forge,readonly", "type=bind,src=/tmp/solc,dst=/tools/solc,readonly",
    ]);
    assert.deepEqual(args.flatMap((arg, index) => arg === "--tmpfs" ? [args[index + 1]] : []), [
      "/work:rw,nosuid,nodev,noexec,size=768m,uid=1000,gid=1000,mode=0700",
      "/work/tools:rw,nosuid,nodev,exec,size=512m,uid=1000,gid=1000,mode=0700",
      "/home/gate:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000,mode=0700",
      "/tmp:rw,nosuid,nodev,noexec,size=64m,uid=1000,gid=1000,mode=0700",
    ]);
    for (const flag of ["--volume", "-v", "--volumes-from", "--cap-add"]) {assert.equal(args.includes(flag), false);}
  });

  for (const scenario of [
    {name: "success", body: "printf '0\\n' > /work/gate-output/slither.exit; rm /work/gate-output/failure.stage", status: 0},
    {name: "policy findings", body: "printf '255\\n' > /work/gate-output/slither.exit; rm /work/gate-output/failure.stage", status: 0},
    {name: "compiler failure", body: "printf 'compiler-build\\n' > /work/gate-output/failure.stage; exit 42", status: 42},
    {name: "analyzer failure", body: "printf 'analysis-runtime\\n' > /work/gate-output/failure.stage; exit 255", status: 255},
    {name: "errexit", body: "printf 'analysis-runtime\\n' > /work/gate-output/failure.stage; false; touch /work/unreachable", status: 1},
    {name: "pipefail", body: "printf 'detector-inventory\\n' > /work/gate-output/failure.stage; false | true", status: 1},
  ]) {
    test(`${create.name}: actual FIFO shell and Python reader retain ${scenario.name} until reap`, {timeout: 10_000}, async (t) => {
      // Actual emitted bootstrap/trap/reader; only paths, ownership and analyzer
      // body are adapted for a host process. This is not Docker E2E evidence.
      const directory = await makeTestDirectory("completion-");
      const owner = await lstat(directory);
      assert.equal(owner.isDirectory(), true);
      assert.equal(owner.mode & 0o7777, 0o700);
      assert.equal(owner.uid, process.getuid!());
      // Capture ownership before launching helpers. macOS inherits the
      // directory GID; on Linux simulate only a differing process primary GID.
      if (process.getgid!() === owner.gid) {t.mock.method(process, "getgid", () => owner.gid + 1, {});}
      assert.notEqual(owner.gid, process.getgid!());
      const script = create(paths).at(-1)!;
      const boundary = script.indexOf('test "$(id -u):$(id -g)"');
      assert.ok(boundary > 0);
      const program = `${script.slice(0, boundary)}${scenario.body}`.replaceAll("/work", directory);
      const child = spawn("/bin/bash", ["-ceu", program], {detached: true, stdio: ["ignore", "pipe", "pipe"]});
      let stderr = "";
      child.stderr.on("data", (chunk) => {stderr += String(chunk);});
      child.once("error", (error) => {stderr += error.message;});
      const closed = new Promise<void>((resolve) => {child.once("close", () => resolve());});
      t.after(async () => {
        try {await reapFixture(child, closed);} finally {await rm(directory, {recursive: true, force: true});}
      });
      const port = new OwnedProcess();
      const authorized = await port.run("/bin/bash", ["-ceu", AUTHORIZE_ANALYSIS.replaceAll("/work", directory)], 3_000);
      assert.equal(authorized.exitCode, 0, authorized.stderr);
      const reader = COMPLETION_READER.replaceAll("/work", directory).replace("st_uid != 1000", `st_uid != ${owner.uid}`).replace("st_gid != 1000", `st_gid != ${owner.gid}`);
      const completed = await port.run("/usr/bin/python3", ["-I", "-S", "-c", reader], 3_000);
      assert.equal(completed.timedOut, false, stderr);
      assert.equal(completed.exitCode, 0, completed.stderr);
      assert.equal(completed.stdout, `SLITHER_COMPLETED_V1 ${scenario.status}\n`);
      assert.equal(child.exitCode, null, stderr);
      assert.equal(child.signalCode, null, stderr);
      process.kill(child.pid!, 0);
      assert.equal((await stat(join(directory, "gate-completion"))).isFIFO(), true);
      const fifo = await lstat(join(directory, "gate-completion"));
      assert.deepEqual({uid: fifo.uid, gid: fifo.gid}, {uid: owner.uid, gid: owner.gid});
      if (scenario.status === 0) {
        assert.equal(await readFile(join(directory, "gate-output/slither.exit"), "utf8"), scenario.name === "policy findings" ? "255\n" : "0\n");
        await assert.rejects(readFile(join(directory, "gate-output/failure.stage")), {code: "ENOENT"});
      } else {
        assert.match(await readFile(join(directory, "gate-output/failure.stage"), "utf8"), /^(compiler-build|analysis-runtime|detector-inventory)\n$/u);
      }
      await assert.rejects(readFile(join(directory, "unreachable")), {code: "ENOENT"});
      // The shell/FIFO checks above run on every supported host. Only this
      // inspection of real kernel process records needs Linux procfs.
      await t.test("Linux retained shell procfs snapshot", {skip: process.platform !== "linux" && "requires Linux /proc/PID/stat and /proc/PID/task"}, async () => {
        const proc = join(directory, "proc");
        const host = join(directory, "host");
        await mkdir(proc); await mkdir(host, {mode: 0o700});
        // Inspect the actual retained shell's stat/tasks via a synthetic namespace
        // view. No privileged namespace or Docker socket is needed for this test.
        await symlink(`/proc/${child.pid}`, join(proc, "1"));
        const exporter = OUTPUT_EXPORTER.replace('ROOT = "/work"', `ROOT = ${JSON.stringify(directory)}`).replace('PROC = "/proc"', `PROC = ${JSON.stringify(proc)}`).replace("OWNER_UID = 1000", `OWNER_UID = ${owner.uid}`).replace("OWNER_GID = 1000", `OWNER_GID = ${owner.gid}`);
        const allowed = scenario.status === 0 ? ["slither.exit"] : ["slither.exit", "failure.stage"];
        const exported = await port.run("/usr/bin/python3", ["-I", "-S", "-c", exporter, JSON.stringify(allowed), scenario.status === 0 ? "exact" : "partial"], 3_000);
        assert.equal(exported.exitCode, 0, exported.stderr);
        assert.equal(exported.timedOut, false);
        await receiveOutput(exported.stdout, host, allowed, scenario.status === 0);
        const name = scenario.status === 0 ? "slither.exit" : "failure.stage";
        assert.deepEqual(await readFile(join(host, name)), await readFile(join(directory, "gate-output", name)));
        assert.equal(child.exitCode, null, "PID remains held through export and host authentication");
      });
    });
  }
}
