import assert from "node:assert/strict";
import fs, { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { FIXTURE_OUTPUT_FILES, PRODUCTION_OUTPUT_FILES } from "../src/adapters/container-contract.ts";
import { COMPLETION_READER, MAX_FILE_BYTES, MAX_FRAME_BYTES, OUTPUT_EXPORTER, exportArguments, receiveOutput } from "../src/adapters/container-export.ts";
import { OwnedProcess } from "../src/adapters/process.ts";
import type { ProcessResult } from "../src/application/ports.ts";
import { makeTestDirectory } from "./test-directory.ts";

// Only the Linux descriptor-path capability is replaced for private host
// fixtures. All decoding, permissions, exclusive writes and identity checks
// remain real. These fixtures do not prove Darwin container support.
const fixtureDirectoryPath = (_fd: number, directory: string): string => directory;
async function receiveFixtureOutput(raw: string, directory: string, allowlist: readonly string[], exact: boolean): Promise<void> {
  await receiveOutput(raw, directory, allowlist, exact, fixtureDirectoryPath);
}

const rejected = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ARTIFACT_EXPORT_FAILED";
const wrap = (body: string): string => `SLITHER_EXPORT_V1\n${body}\nSLITHER_EXPORT_END\n`;
const frame = (files: Readonly<Record<string, Buffer>>): string => wrap(JSON.stringify(Object.keys(files).toSorted().map((name) => [name, files[name]!.length, files[name]!.toString("base64")])));

async function scratch(t: TestContext): Promise<string> {
  const root = await makeTestDirectory("export-");
  t.after(async () => {await rm(root, {recursive: true, force: true});});
  return root;
}

async function fixtureOwner(directory: string) {
  const owner = await lstat(directory);
  assert.equal(owner.isDirectory(), true);
  assert.equal(owner.mode & 0o7777, 0o700);
  assert.equal(owner.uid, process.getuid!());
  // Capture a deliberately created directory before adversarial changes. A
  // child's inherited filesystem GID need not be the process's primary GID.
  return {uid: owner.uid, gid: owner.gid};
}

async function fifoPair(path: string, reader: string, timeout = 3_000): Promise<ProcessResult> {
  // A host writeFile on a FIFO can strand a libuv thread if the reader fails
  // before open. Each helper here has an exact child PID, a deadline and a
  // close event awaited by OwnedProcess, including a failed reader branch.
  const writer = 'import sys\nwith open(sys.argv[1], "wb") as pipe: pipe.write(b"x" * 100)';
  const port = new OwnedProcess();
  const results = await Promise.allSettled([
    port.run("/usr/bin/python3", ["-I", "-S", "-c", writer, path], timeout),
    port.run("/usr/bin/python3", ["-I", "-S", "-c", reader], timeout),
  ]);
  const [writing, reading] = results;
  assert.equal(writing.status, "fulfilled");
  assert.equal(reading.status, "fulfilled");
  if (reading.value.exitCode === 0) {
    assert.equal(writing.value.exitCode, 0, writing.value.stderr);
    assert.equal(writing.value.timedOut, false);
  } else {
    assert.equal(writing.value.timedOut, true, "unopened writer must be killed and reaped");
  }
  return reading.value;
}

test("default output filesystem requires Linux descriptor access", async (t) => {
  const output = await scratch(t);
  const raw = frame({"slither.exit": Buffer.from("0\n")});
  if (process.platform === "linux") {
    await receiveOutput(raw, output, ["slither.exit"], true);
    assert.equal(await readFile(join(output, "slither.exit"), "utf8"), "0\n");
  } else {
    await assert.rejects(receiveOutput(raw, output, ["slither.exit"], true), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error);
      assert.match(error.cause.message, /requires Linux procfs/u);
      return rejected(error);
    });
    assert.deepEqual(await readdir(output), []);
  }
});

test("Linux descriptor creation stays with the held directory after path substitution", {skip: process.platform !== "linux" && "requires Linux /proc/self/fd directory traversal"}, async (t) => {
  const root = await scratch(t);
  const output = join(root, "output");
  const held = join(root, "held");
  await mkdir(output, {mode: 0o700});
  // Inject a rename at the first descriptor-based read, after open/stat but
  // before exclusive creation. The replacement must never receive the bytes.
  const originalRead = fs.readdir;
  t.mock.method(fs, "readdir", async (...args: Parameters<typeof fs.readdir>) => {
    if (String(args[0]).startsWith("/proc/self/fd/")) {
      await rename(output, held);
      await mkdir(output, {mode: 0o700});
    }
    return await originalRead(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
  await assert.rejects(receiveOutput(frame({"slither.exit": Buffer.from("0\n")}), output, ["slither.exit"], true), rejected);
  assert.deepEqual(await readdir(output), []);
  assert.equal(await readFile(join(held, "slither.exit"), "utf8"), "0\n");
});

async function processRecord(proc: string, pid: number, state = "S"): Promise<void> {
  await mkdir(join(proc, `${pid}/task/${pid}`), {recursive: true});
  // /proc stat fields 3 through 22 (state through starttime).
  await writeFile(join(proc, `${pid}/stat`), `${pid} (fixture process) ${state} ${Array(18).fill("0").join(" ")} 123\n`);
}

async function exporter(t: TestContext, contents: Readonly<Record<string, Buffer>> = {"slither.exit": Buffer.from("0\n")}) {
  const root = await scratch(t);
  const work = join(root, "work");
  const output = join(work, "gate-output");
  const proc = join(root, "proc");
  const host = join(root, "host");
  await mkdir(work, {mode: 0o700});
  const owner = await fixtureOwner(work);
  await mkdir(output, {mode: 0o700});
  assert.deepEqual(await fixtureOwner(output), owner);
  await mkdir(host, {mode: 0o700});
  await processRecord(proc, 1);
  for (const [name, bytes] of Object.entries(contents)) {
    await writeFile(join(output, name), bytes, {mode: 0o600});
    const info = await lstat(join(output, name));
    assert.deepEqual({uid: info.uid, gid: info.gid}, owner);
  }
  // Real isolated Python, OS file reads and framing. Only namespace/ownership
  // are fixtures: no Docker or private PID namespace is available here.
  const script = OUTPUT_EXPORTER.replace('ROOT = "/work"', `ROOT = ${JSON.stringify(work)}`).replace('PROC = "/proc"', `PROC = ${JSON.stringify(proc)}`).replace("OWNER_UID = 1000", `OWNER_UID = ${owner.uid}`).replace("OWNER_GID = 1000", `OWNER_GID = ${owner.gid}`);
  const run = async (program?: string, allowed?: readonly string[], exact = true) => await new OwnedProcess().run("/usr/bin/python3", ["-I", "-S", "-c", program ?? script, JSON.stringify(allowed ?? Object.keys(contents)), exact ? "exact" : "partial"], 5_000);
  return {root, work, output, proc, host, owner, script, run};
}

test("isolated Python exports exact binary bytes without site/cwd imports", async (t) => {
  const inherited = await fixtureOwner(await scratch(t));
  // Linux commonly has equal groups. Inject only the reported process GID;
  // all directory/file metadata, Python validation and transport remain real.
  if (process.getgid!() === inherited.gid) {t.mock.method(process, "getgid", () => inherited.gid + 1, {});}
  const bytes = Buffer.from(Array.from({length: 256}, (_, index) => index));
  const contents = {"slither.json": bytes, "slither.exit": Buffer.from("255\n")};
  const fixture = await exporter(t, contents);
  assert.notEqual(fixture.owner.gid, process.getgid!());
  const poisoned = join(fixture.root, "python");
  await mkdir(poisoned);
  for (const name of ["sitecustomize.py", "usercustomize.py", "json.py"]) {await writeFile(join(poisoned, name), "raise RuntimeError('untrusted import')\n");}
  const args = ["-I", "-S", "-c", fixture.script, JSON.stringify(Object.keys(contents)), "exact"];
  const exported = await new OwnedProcess().run("/usr/bin/python3", args, 5_000, {env: {PATH: "/usr/bin:/bin", PYTHONPATH: poisoned, PYTHONHOME: poisoned}});
  assert.equal(exported.exitCode, 0, exported.stderr);
  assert.equal(exported.timedOut, false);
  assert.equal(exported.stdout, frame(contents));
  await receiveFixtureOutput(exported.stdout, fixture.host, Object.keys(contents), true);
  for (const [name, original] of Object.entries(contents)) {
    assert.deepEqual(await readFile(join(fixture.host, name)), original);
    const info = await lstat(join(fixture.host, name));
    assert.equal(info.mode & 0o7777, 0o600);
    assert.equal(info.uid, process.getuid!());
    assert.equal(info.nlink, 1);
  }
});

for (const allowlist of [PRODUCTION_OUTPUT_FILES, FIXTURE_OUTPUT_FILES]) {
  test(`actual Python obeys the complete ${allowlist[0]} allowlist`, async (t) => {
    const contents = Object.fromEntries(allowlist.map((name) => [name, Buffer.from(`${name}\n`)]));
    const fixture = await exporter(t, contents);
    const exported = await fixture.run();
    assert.equal(exported.exitCode, 0, exported.stderr);
    await receiveFixtureOutput(exported.stdout, fixture.host, allowlist, true);
    assert.deepEqual((await readdir(fixture.host)).toSorted(), allowlist.toSorted());
    assert.deepEqual(exportArguments("a".repeat(64), allowlist, true).slice(0, 6), ["exec", "a".repeat(64), "/usr/bin/python3", "-I", "-S", "-c"]);
  });
}

test("partial failure preserves empty intermediate bytes and failure.stage", async (t) => {
  const contents = {"slither.json": Buffer.alloc(0), "failure.stage": Buffer.from("analysis-runtime\n")};
  const fixture = await exporter(t, contents);
  const allowed = [...PRODUCTION_OUTPUT_FILES, "failure.stage"];
  const exported = await fixture.run(fixture.script, allowed, false);
  assert.equal(exported.exitCode, 0, exported.stderr);
  await receiveFixtureOutput(exported.stdout, fixture.host, allowed, false);
  assert.deepEqual(await readFile(join(fixture.host, "slither.json")), Buffer.alloc(0));
  assert.equal(await readFile(join(fixture.host, "failure.stage"), "utf8"), "analysis-runtime\n");
  assert.equal((await fixture.run(fixture.script, allowed, true)).exitCode, 1);
});

for (const fault of ["symlink", "hardlink", "fifo", "directory", "mode", "executable", "special-mode", "owner", "group", "output-link", "work-link", "directory-mode", "unexpected", "empty", "oversized"] as const) {
  test(`actual Python rejects ${fault} without emitting a frame`, async (t) => {
    const fixture = await exporter(t);
    const path = join(fixture.output, "slither.exit");
    let script = fixture.script;
    if (["symlink", "fifo", "directory", "empty"].includes(fault)) {await rm(path);}
    if (fault === "symlink") {await symlink("/etc/passwd", path);}
    if (fault === "hardlink") {await link(path, join(fixture.work, "alias"));}
    if (fault === "fifo") {assert.equal((await new OwnedProcess().run("/usr/bin/mkfifo", ["-m", "600", path], 3_000)).exitCode, 0);}
    if (fault === "directory") {await mkdir(path, {mode: 0o700});}
    if (fault === "mode") {await chmod(path, 0o644);}
    if (fault === "executable") {await chmod(path, 0o700);}
    if (fault === "special-mode") {await chmod(path, 0o4600);}
    if (fault === "directory-mode") {await chmod(fixture.output, 0o755);}
    if (fault === "owner") {script = script.replaceAll("info.st_uid == OWNER_UID", "info.st_uid == OWNER_UID + 1");}
    if (fault === "group") {script = script.replaceAll("info.st_gid == OWNER_GID", "info.st_gid == OWNER_GID + 1");}
    if (fault === "output-link") {await rm(fixture.output, {recursive: true}); await symlink(fixture.host, fixture.output);}
    if (fault === "work-link") {const alias = join(fixture.root, "alias"); await symlink(fixture.work, alias); script = script.replace(JSON.stringify(fixture.work), JSON.stringify(alias));}
    if (fault === "unexpected") {await writeFile(join(fixture.output, "surprise"), "untrusted", {mode: 0o600});}
    if (fault === "oversized") {await truncate(path, MAX_FILE_BYTES + 1);}
    const exported = await fixture.run(script);
    assert.equal(exported.timedOut, false, fault);
    assert.equal(exported.exitCode, 1, fault);
    assert.equal(exported.stdout, "", fault);
    assert.equal(exported.stderr, "SLITHER_EXPORT_FAILED\n");
  });
}

test("actual Python enforces aggregate size before emitting any bytes", async (t) => {
  const names = PRODUCTION_OUTPUT_FILES.slice(0, 5);
  const fixture = await exporter(t, Object.fromEntries(names.map((name) => [name, Buffer.alloc(0)])));
  for (const name of names) {await truncate(join(fixture.output, name), MAX_FILE_BYTES);}
  const exported = await fixture.run();
  assert.equal(exported.exitCode, 1, exported.stderr);
  assert.equal(exported.stdout, "");
  assert.equal(exported.timedOut, false);
});

test("actual Python accepts the exact per-file byte limit", async (t) => {
  const fixture = await exporter(t);
  await truncate(join(fixture.output, "slither.exit"), MAX_FILE_BYTES);
  const exported = await fixture.run();
  assert.equal(exported.exitCode, 0, exported.stderr);
  await receiveFixtureOutput(exported.stdout, fixture.host, ["slither.exit"], true);
  assert.deepEqual(await readFile(join(fixture.output, "slither.exit")), await readFile(join(fixture.host, "slither.exit")));
});

for (const state of ["S", "R", "T", "D", "Z"]) {
  test(`surviving ${state} descendant is rejected before export`, async (t) => {
    const fixture = await exporter(t);
    await processRecord(fixture.proc, 2, state);
    const exported = await fixture.run();
    assert.equal(exported.exitCode, 1);
    assert.equal(exported.stdout, "");
  });
}

test("extra PID 1 threads or a running PID 1 fail closed", async (t) => {
  const fixture = await exporter(t);
  assert.equal((await fixture.run()).exitCode, 0);
  await processRecord(fixture.proc, 1, "R");
  assert.equal((await fixture.run()).exitCode, 1);
  await processRecord(fixture.proc, 1, "S");
  await mkdir(join(fixture.proc, "1/task/3"));
  assert.equal((await fixture.run()).exitCode, 1);
});

for (const mutation of [
  'with open(ROOT + "/gate-output/slither.exit", "wb") as changed: changed.write(b"1\\n")',
  'os.chmod(ROOT + "/gate-output/slither.exit", 0o400)',
  'os.chmod(ROOT, 0o755)',
  'os.unlink(ROOT + "/gate-output/slither.exit"); open(ROOT + "/gate-output/slither.exit", "wb").write(b"0\\n")',
  'open(ROOT + "/gate-output/extra", "wb").close()',
  'os.rename(ROOT + "/gate-output", ROOT + "/old"); os.mkdir(ROOT + "/gate-output", 0o700)',
  'os.unlink(PROC + "/1/stat")',
  'os.mkdir(PROC + "/1/task/9")',
  'os.mkdir(PROC + "/2"); open(PROC + "/2/stat", "wb").write(b"2 (late child) S " + b"0 " * 18 + b"124\\n")',
  'open(PROC + "/1/stat", "wb").write(b"1 (replacement) S " + b"0 " * 18 + b"124\\n")',
]) {
  test(`actual mid-snapshot filesystem mutation fails closed: ${mutation}`, async (t) => {
    const fixture = await exporter(t);
    // Deterministic fault injection into the real Python between passes.
    const script = fixture.script.replace("        # Keep every descriptor", `        ${mutation}\n        # Keep every descriptor`);
    const exported = await fixture.run(script);
    assert.equal(exported.exitCode, 1);
    assert.equal(exported.stdout, "");
  });
}

for (const body of [
  "[]", "{}", "null", "[", '[["slither.exit",2,"MAo="],["slither.exit",2,"MAo="]]',
  '[["../slither.exit",2,"MAo="]]', '[["/slither.exit",2,"MAo="]]', '[["slither.exit/child",2,"MAo="]]',
  '[["failure.stage",2,"MAo="]]', '[["slither.exit",-1,""]]', '[["slither.exit",1.5,"MAo="]]',
  '[["slither.exit",2,"MAp="]]', '[["slither.exit",2,"MAo_"]]', '[["slither.exit",2,"MAo"]]',
  '[["slither.exit",2,"M A="]]', '[["slither.exit",1,"MAo="]]', '[["slither.exit",2,"MAo=",0]]',
  '[["slither.exit",2,{"data":"MAo=","data":"MAo="}]]', '[ ["slither.exit",2,"MAo="] ]',
  `[["slither.exit",${MAX_FILE_BYTES + 1},""]]`, '[["slither.exit","2","MAo="]]',
]) {
  test(`host rejects malformed, duplicate or unexpected data: ${body}`, async (t) => {
    const output = await scratch(t);
    await assert.rejects(receiveFixtureOutput(wrap(body), output, ["slither.exit"], true), rejected);
    assert.deepEqual(await readdir(output), []);
  });
}

test("host rejects missing, truncated, repeated and oversized frames before writes", async (t) => {
  const output = await scratch(t);
  const valid = frame({"slither.exit": Buffer.from("0\n")});
  for (const raw of ["", valid.slice(0, -1), valid + valid, valid + "extra", "x".repeat(MAX_FRAME_BYTES + 1)]) {
    await assert.rejects(receiveFixtureOutput(raw, output, ["slither.exit"], true), rejected);
  }
  assert.deepEqual(await readdir(output), []);
});

test("host preserves preexisting files and rejects symlink or nonprivate directories", async (t) => {
  const root = await scratch(t);
  const output = join(root, "output");
  await mkdir(output, {mode: 0o700});
  const raw = frame({"slither.exit": Buffer.from("0\n")});
  await writeFile(join(output, "slither.exit"), "preserve");
  await assert.rejects(receiveFixtureOutput(raw, output, ["slither.exit"], true), rejected);
  assert.equal(await readFile(join(output, "slither.exit"), "utf8"), "preserve");
  await rm(join(output, "slither.exit"));
  const alias = join(root, "alias");
  await symlink(output, alias);
  await assert.rejects(receiveFixtureOutput(raw, alias, ["slither.exit"], true), rejected);
  await symlink(join(root, "outside"), join(output, "slither.exit"));
  await assert.rejects(receiveFixtureOutput(raw, output, ["slither.exit"], true), rejected);
  await assert.rejects(lstat(join(root, "outside")), {code: "ENOENT"});
  await rm(join(output, "slither.exit"));
  await chmod(output, 0o755);
  await assert.rejects(receiveFixtureOutput(raw, output, ["slither.exit"], true), rejected);
});

test("completion Python rejects a regular file and caps FIFO bytes", async (t) => {
  const root = await scratch(t);
  const owner = await fixtureOwner(root);
  if (process.getgid!() === owner.gid) {t.mock.method(process, "getgid", () => owner.gid + 1, {});}
  assert.notEqual(owner.gid, process.getgid!());
  const path = join(root, "gate-completion");
  const reader = COMPLETION_READER.replaceAll("/work", root).replace("st_uid != 1000", `st_uid != ${owner.uid}`).replace("st_gid != 1000", `st_gid != ${owner.gid}`);
  const port = new OwnedProcess();
  await writeFile(path, "SLITHER_COMPLETED_V1 0\n", {mode: 0o600});
  assert.equal((await port.run("/usr/bin/python3", ["-I", "-S", "-c", reader], 3_000)).exitCode, 1);
  await rm(path);
  assert.equal((await port.run("/usr/bin/mkfifo", ["-m", "600", path], 3_000)).exitCode, 0);
  const fifo = await lstat(path);
  assert.deepEqual({uid: fifo.uid, gid: fifo.gid}, owner);
  const read = await fifoPair(path, reader);
  assert.equal(read.exitCode, 0);
  assert.equal(read.stdout, "x".repeat(32));
});


test("host aggregate cap rejects a valid frame that is below the encoded frame limit", async (t) => {
  const output = await scratch(t);
  const encoded = Buffer.alloc(MAX_FILE_BYTES).toString("base64");
  const names = PRODUCTION_OUTPUT_FILES.slice(0, 5).toSorted();
  const rows = names.map((name, index) => index === 4 ? [name, 1, "AA=="] : [name, MAX_FILE_BYTES, encoded]);
  const raw = wrap(JSON.stringify(rows));
  assert.ok(raw.length < MAX_FRAME_BYTES);
  await assert.rejects(receiveFixtureOutput(raw, output, names, true), rejected);
  assert.deepEqual(await readdir(output), []);
});

test("failed completion reader bounds and reaps the blocked FIFO writer", {timeout: 3_000}, async (t) => {
  const root = await scratch(t);
  const path = join(root, "gate-completion");
  assert.equal((await new OwnedProcess().run("/usr/bin/mkfifo", ["-m", "600", path], 3_000)).exitCode, 0);
  const read = await fifoPair(path, "raise RuntimeError('fixture failure before FIFO open')", 500);
  assert.equal(read.exitCode, 1);
  assert.equal(read.timedOut, false);
});
