import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { makeTestDirectory } from "./test-directory.ts";

const cli = resolvePath("tooling/security/slither/src/composition/cli.ts");
const source = pathToFileURL(resolvePath("tooling/security/slither/src/") + "/").href;
const id = "d".repeat(64);

type Phase = "validation" | "process" | "create" | "completion" | "export" | "cleanup" | "prepublication" | "happy";

// Only external gate inputs/analysis are substituted. The launched entrypoint,
// signal ownership, OwnedProcess, container lifecycle, and POSIX children are real.
// Synthetic Docker protocol responses are NOT Docker interruption qualification.
function preload(directory: string, phase: Phase, cleanupFails: boolean): string {
  return `
    import { mock } from 'node:test';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const directory = ${JSON.stringify(directory)};
    const phase = ${JSON.stringify(phase)};
    const id = ${JSON.stringify(id)};
    const source = ${JSON.stringify(source)};
    const { createContainerRunner } = await import(source + 'adapters/container-runtime.ts');
    const { COMPLETION_READER } = await import(source + 'adapters/container-export.ts');
    const { SlitherGateError } = await import(source + 'domain/model.ts');
    const originalRead = fs.readFile, originalStat = fs.lstat, originalLink = fs.readlink;
    const leaf = '/sys/fs/cgroup/system.slice/docker-' + id + '.scope';
    const parent = '/sys/fs/cgroup/system.slice';
    const files = {
      '/proc/2/cgroup': '0::/system.slice/docker-' + id + '.scope\\n',
      [parent + '/cgroup.controllers']: 'cpu memory pids\\n', [parent + '/cgroup.subtree_control']: 'cpu memory pids\\n',
      [leaf + '/pids.max']: '128\\n', [leaf + '/memory.max']: '2147483648\\n', [leaf + '/cpu.max']: '200000 100000\\n'
    };
    fs.readFile = async (...args) => String(args[0]) in files ? files[String(args[0])] : await originalRead(...args);
    fs.readlink = async (...args) => String(args[0]) === '/proc/self/ns/pid' ? 'pid:[1]' : String(args[0]) === '/proc/2/ns/pid' ? 'pid:[2]' : await originalLink(...args);
    fs.lstat = async (...args) => [leaf, parent].includes(String(args[0])) ? {dev: 1n, ino: String(args[0]) === leaf ? 2n : 3n, isDirectory: () => true, isSymbolicLink: () => false} : await originalStat(...args);
    syncBuiltinESMExports();
    const note = async (entry) => { await fs.appendFile(directory + '/calls', JSON.stringify(entry) + '\\n'); };
    const wait = async (ms) => await new Promise(resolve => setTimeout(resolve, ms));
    const notify = (value) => process.send?.(value);
    process.on('exit', () => {
      // Exit observers do not participate in cleanup; they only expose listener leaks.
      notify({kind: 'listeners', int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')});
    });
    mock.module(source + 'adapters/validated-environment.ts', {namedExports: {validateEnvironment: async () => {
      if (phase === 'validation') {notify({kind: 'ready'}); await wait(250);}
      return {repositoryRoot: directory, candidateSha: 'a'.repeat(40), output: directory + '/output'};
    }}});
    mock.module(source + 'adapters/executable.ts', {namedExports: {resolveDockerCli: async () => '/synthetic/docker'}});
    mock.module(source + 'adapters/repository.ts', {namedExports: {GitRepositoryState: class {
      async assertExactClean() {} async trackedProductionSources() {return [];}
    }}});
    mock.module(source + 'application/gate.ts', {namedExports: {executeGate: async (_sha, _repository, analysis) => {
      await analysis.run(); return {decision: {exitCode: 0}};
    }}});
    mock.module(source + 'adapters/evidence.ts', {namedExports: {
      ExclusiveDirectoryPublication: class { async revoke() {} async finalize() {} },
      writeReadyEvidence: async (request) => {
        await note(['publication']);
        if (phase === 'prepublication') {notify({kind: 'ready'}); await wait(250);}
        await request.assertReadyPrecondition();
        await fs.writeFile(directory + '/READY', '');
      },
      writeFailureEvidence: async () => { await note(['failure-publication']); }
    }});
    mock.module(source + 'adapters/runner.ts', {namedExports: {runGate: async ({processPort}) => {
      if (phase === 'happy' || phase === 'prepublication') {return;}
      if (phase === 'process') {
        const child = "require('node:fs').writeFileSync(" + JSON.stringify(directory + '/child') + ", String(process.pid));setTimeout(()=>{},5000)";
        await processPort.run(process.execPath, ['-e', child], 5000);
        await note(['vulnerable-stage']);
        return;
      }
      await fs.mkdir(directory + '/raw', {mode: 0o700});
      let started = false;
      const port = {signal: processPort.signal, run: async (_command, args, timeout, options) => {
        await note(args);
        let stdout = '', stop = false;
        if (args[0] === 'info') {stdout = JSON.stringify({CgroupDriver: 'systemd', CgroupVersion: '2'});}
        else if (args[0] === 'create') {stdout = id + '\\n'; stop = phase === 'create';}
        else if (args[0] === 'start') {started = true; stdout = id + '\\n';}
        else if (args[0] === 'container') {stdout = JSON.stringify({Id: id, State: {Running: started, Paused: false, Pid: 2}, HostConfig: {PidsLimit: 128, Memory: 2147483648, MemorySwap: 2147483648, NanoCpus: 2000000000}});}
        else if (args[0] === 'rm') {stdout = id + '\\n'; stop = phase === 'cleanup'; if (${cleanupFails}) {throw new SlitherGateError('CONTAINER_FAILED', 'synthetic removal failure');}}
        else if (args[6] === COMPLETION_READER) {stdout = 'SLITHER_COMPLETED_V1 0\\n'; stop = phase === 'completion';}
        else if (args.length === 9) {stdout = 'SLITHER_EXPORT_V1\\n[["slither.exit",2,"MAo="]]\\nSLITHER_EXPORT_END\\n'; stop = phase === 'export';}
        if (!stop && args[0] !== 'rm') {return {stdout, stderr: '', exitCode: 0, timedOut: false};}
        const delay = stop ? ((phase === 'create' || phase === 'cleanup') ? 400 : 5000) : 0;
        const marker = stop ? "require('node:fs').writeFileSync(" + JSON.stringify(directory + '/child') + ", String(process.pid));" : '';
        const script = marker + 'setTimeout(() => process.stdout.write(' + JSON.stringify(stdout) + '), ' + delay + ')';
        return await processPort.run(process.execPath, ['-e', script], Math.min(timeout, 5500), options);
      }};
      await createContainerRunner((_fd, path) => path)(port, '/synthetic/docker', ['create'], { output: directory + '/raw', allowlist: ['slither.exit'] });
      await note(['vulnerable-stage']);
      // An already cancelled second lifecycle must not launch even docker info.
      await createContainerRunner((_fd, path) => path)(port, '/synthetic/docker', ['create'], { output: directory + '/raw', allowlist: ['slither.exit'] });
    }}});
  `;
}

async function groupRows(pgid: number): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile("/bin/ps", ["-axo", "pid=,pgid=,stat="], {env: {PATH: "/usr/bin:/bin", LC_ALL: "C"}, timeout: 1_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL"}, (error, output) => error ? reject(error) : resolve(output));
  });
  return stdout.trim().split("\n").filter((row) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(row);
    assert.ok(match, "fixture observer must parse every row");
    return Number(match[2]) === pgid && !match[3]!.startsWith("Z");
  });
}

async function fixture(t: TestContext, phase: Phase, cleanupFails = false) {
  const directory = await makeTestDirectory("parent-signal-");
  const script = join(directory, "preload.mjs");
  await writeFile(script, preload(directory, phase, cleanupFails), {mode: 0o600});
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--import", script, cli], {
    env: {PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1"}, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  let stderr = ""; let stdout = ""; let ready = false;
  child.stderr!.on("data", (chunk: Buffer) => {stderr += chunk.toString();});
  child.stdout!.on("data", (chunk: Buffer) => {stdout += chunk.toString();});
  const messages: {kind: string; int?: number; term?: number}[] = [];
  child.on("message", (message: {kind: string; int?: number; term?: number}) => {messages.push(message); if (message.kind === "ready") {ready = true;}});
  // Parent uses its live ChildProcess handle; synthetic descendants have a 5s
  // watchdog. Tests never signal a PGID rediscovered from a file or ps output.
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
    await closed;
    await rm(directory, {recursive: true, force: true});
  });
  const awaitReady = async (): Promise<number | undefined> => {
    const deadline = performance.now() + 10_000;
    while (true) {
      if (ready) { return undefined; }
      const value = await readFile(join(directory, "child"), "utf8").catch(() => "");
      if (value) {return Number(value);}
      assert.equal(child.exitCode, null, `CLI exited before fixture readiness: ${stderr}`);
      assert.equal(child.signalCode, null);
      assert.ok(performance.now() < deadline, `CLI fixture readiness timed out: ${stderr}`);
      await new Promise<void>((resolve) => {setTimeout(resolve, 10);});
    }
  };
  return {child, closed, directory, awaitReady, messages, stderr: () => stderr, stdout: () => stdout};
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  for (const phase of ["validation", "process", "create", "completion", "export", "cleanup", "prepublication"] as const) {
    test(`actual CLI ${signal} during ${phase} preserves interruption and scoped cleanup`, {timeout: 20_000}, async (t) => {
      const run = await fixture(t, phase);
      const pgid = await run.awaitReady();
      const start = performance.now();
      assert.equal(run.child.kill(signal), true);
      // A second catchable signal cannot bypass the already owned finalizer.
      if (["validation", "create", "cleanup", "prepublication"].includes(phase)) {
        await new Promise<void>((resolve) => {setTimeout(resolve, 30);});
        assert.equal(run.child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT"), true);
      }
      const [exitCode, exitSignal] = await run.closed;
      assert.equal(exitSignal, null, run.stderr());
      assert.equal(exitCode, signal === "SIGINT" ? 130 : 143, run.stderr());
      assert.match(run.stderr(), new RegExp('SLITHER_CANCELLED: ' + signal, 'u'));
      assert.doesNotMatch(run.stderr(), /cleanup may be unconfirmed/u);
      assert.ok(performance.now() - start < 2_000);
      assert.equal(run.stdout(), "");
      if (pgid !== undefined) {assert.deepEqual(await groupRows(pgid), []);}
      const calls = (await readFile(join(run.directory, "calls"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.some((args) => args[0] === "vulnerable-stage" || args[0] === "failure-publication"), false);
      if (["create", "completion", "export", "cleanup"].includes(phase)) {
        assert.deepEqual(calls.at(-1), ["rm", "--force", id]);
        assert.equal(calls.filter((args) => args[0] === "create").length, 1);
        if (phase === "create") {assert.equal(calls.some((args) => args[0] === "start"), false);}
      }
      await assert.rejects(readFile(join(run.directory, "READY")));
      assert.deepEqual(run.messages.find((message) => message.kind === "listeners"), {kind: "listeners", int: 0, term: 0});
    });
  }
}

test("actual CLI preserves interruption exit status and reports cleanup uncertainty", {timeout: 20_000}, async (t) => {
  const run = await fixture(t, "completion", true);
  const pgid = await run.awaitReady();
  run.child.kill("SIGTERM");
  assert.deepEqual(await run.closed, [143, null]);
  assert.match(run.stderr(), /SLITHER_CANCELLED: SIGTERM/u);
  assert.match(run.stderr(), /cleanup may be unconfirmed/u);
  assert.deepEqual(await groupRows(pgid!), []);
  await assert.rejects(readFile(join(run.directory, "READY")));
});

test("actual CLI normal completion removes its listeners", async (t) => {
  const run = await fixture(t, "happy");
  assert.deepEqual(await run.closed, [0, null], run.stderr());
  assert.equal(await readFile(join(run.directory, "READY"), "utf8"), "");
  assert.deepEqual(run.messages.find((message) => message.kind === "listeners"), {kind: "listeners", int: 0, term: 0});
});

test("importing public CLI installs no process signal listeners", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await import("../src/composition/cli.ts");
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});
