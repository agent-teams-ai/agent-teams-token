import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { AnalysisInput, GateManifest, PolicyDecision } from "../src/domain/model.ts";
import { writeCanonicalFixture } from "./evidence-canonical-fixture.ts";
import { makeCompilerEvidence } from "./test-compiler-evidence.ts";
import { makeTestDirectory } from "./test-directory.ts";

const testBuild = makeCompilerEvidence("contract A {}\n");
const bytecode = testBuild.compilerEvidence.creationBytecodeSha256;
const manifest: GateManifest = { schemaVersion: 1, targets: [{ path: "contracts/evm/src/A.sol", contract: "A" }], expectedContracts: ["A"], sources: [{ path: "contracts/evm/src/A.sol", sha256: "1".repeat(64) }], config: [], compiler: { version: "0.8.36+commit.8a079791", evmVersion: "paris", optimizerEnabled: true, optimizerRuns: 200, bytecodeHash: "ipfs", cborMetadata: true, useLiteralContent: false, viaIR: false, experimental: false, remappings: ["@openzeppelin/contracts/=lib/openzeppelin-contracts/contracts/", "openzeppelin-contracts/=lib/openzeppelin-contracts/contracts/"] }, tools: { forgeArchiveSha256: "8c8560de380d58d1ee145934427887b107182367600a3c33aa71f16f2ce7ac57", forgeBinarySha256: "c0fbe3ba32d7f498507042dbb94f5954be51126a76ce84e37d71749e7c9c571f", solcBinarySha256: "c8d35afdddc3cd2743ee88b8f25e0fecd16e2bdd5f2120f37e52cd9cc45ae0e6" }, creationBytecodeSha256: bytecode, vulnerableFixture: testBuild.vulnerableFixture, detectorInventory: { path: "detectors.json", sha256: "d".repeat(64) } };
const detectors = Array.from({ length: 101 }, (_, index) => `d-${index}`);
const input: AnalysisInput = { success: true, findings: [], analyzedContracts: ["A"], analyzedSources: ["src/A.sol"], closure: [], detectorInventory: detectors, compiler: manifest.compiler, creationBytecodeSha256: bytecode, freshFoundryCreationBytecodeSha256: bytecode, analysisErrors: [], forgeBinarySha256: manifest.tools.forgeBinarySha256, solcBinarySha256: manifest.tools.solcBinarySha256, compilerEvidence: testBuild.compilerEvidence, fixtureProof: testBuild.fixtureProof };
const decision: PolicyDecision = { category: "clean", exitCode: 0, blocking: [], visible: [], suppressed: [], errors: [] };

const cli = resolvePath("tooling/security/slither/src/composition/cli.ts");
const source = pathToFileURL(resolvePath("tooling/security/slither/src/") + "/").href;
const schemas = resolvePath("tooling/security/slither");
type Phase = "acquisition" | "copy" | "validation" | "READY" | "staging-cleanup" | "staging-cleanup-return" | "return" | "finalization" | "happy";
type Kind = "analysis" | "failure";

// Real CLI/publication and real signal delivery. Only validated environment,
// repository and analysis inputs are synthetic; this is not Docker qualification.
function preload(directory: string, result: unknown, phase: Phase, kind: Kind, cleanupFails: boolean): string {
  return `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { mock } from 'node:test';
    const directory = ${JSON.stringify(directory)}, phase = ${JSON.stringify(phase)}, kind = ${JSON.stringify(kind)};
    const source = ${JSON.stringify(source)}, output = directory + '/output';
    const { ExclusiveDirectoryPublication, writeReadyEvidence, writeFailureEvidence } = await import(source + 'adapters/evidence.ts');
    const { SlitherGateError } = await import(source + 'domain/model.ts');
    const result = ${JSON.stringify(result)};
    const counts = {analysis: 0, ready: 0, failure: 0};
    let visited = false;
    setTimeout(() => process.exit(99), 8000).unref();
    const pause = async (at) => {
      if (phase !== at || visited) {return;}
      visited = true;
      const continued = new Promise(resolve => process.once('message', resolve));
      process.send({kind: 'ready', phase: at, int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')});
      await continued;
    };
    let directoryReads = 0;
    const realStat = fs.lstat, realOpen = fs.open, realReadDir = fs.readdir, realLink = fs.link, realRmdir = fs.rmdir;
    fs.lstat = async (...args) => {
      const value = await realStat(...args);
      if (String(args[0]) === output) {await pause('acquisition');}
      return value;
    };
    fs.open = async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]).startsWith(output + '/') && !String(args[0]).endsWith('/READY')) {await pause('copy');}
      return handle;
    };
    fs.readdir = async (...args) => {
      const value = await realReadDir(...args);
      if (String(args[0]) === output) {directoryReads++; await pause('validation'); if (directoryReads === 3) {await pause('finalization');}}
      return value;
    };
    fs.link = async (...args) => {
      await realLink(...args);
      if (String(args[1]) === output + '/READY') {await pause('READY');}
    };
    fs.rmdir = async (...args) => {
      const staging = String(args[0]).includes('.output.staging-');
      if (staging) {await pause('staging-cleanup');}
      if (staging && ${cleanupFails}) {throw new Error('synthetic staging cleanup failure');}
      await realRmdir(...args);
      if (staging) {await pause('staging-cleanup-return');}
    };
    syncBuiltinESMExports();
    process.on('exit', () => process.send({kind: 'exit', counts, int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM')}));
    mock.module(source + 'adapters/validated-environment.ts', {namedExports: {validateEnvironment: async () => ({repositoryRoot: directory, candidateSha: 'a'.repeat(40), output})}});
    mock.module(source + 'adapters/executable.ts', {namedExports: {resolveDockerCli: async () => '/synthetic/docker'}});
    mock.module(source + 'adapters/repository.ts', {namedExports: {GitRepositoryState: class {async assertExactClean() {}}}});
    mock.module(source + 'adapters/runner.ts', {namedExports: {runGate: async () => {
      counts.analysis++;
      if (kind === 'failure') {throw new SlitherGateError('IMAGE_UNAVAILABLE', 'synthetic image absence');}
    }}});
    mock.module(source + 'application/gate.ts', {namedExports: {executeGate: async (_sha, _repository, analysis) => {await analysis.run(); return result;}}});
    mock.module(source + 'adapters/evidence.ts', {namedExports: {
      ExclusiveDirectoryPublication,
      writeReadyEvidence: async (request) => {
        counts.ready++;
        await writeReadyEvidence({...request, schemaDirectory: ${JSON.stringify(schemas)}, canonicalDirectory: directory + '/canonical'});
        await pause('return');
      },
      writeFailureEvidence: async (request) => {
        counts.failure++;
        await writeFailureEvidence({...request, schemaDirectory: ${JSON.stringify(schemas)}});
        await pause('return');
      }
    }});
  `;
}

interface Message {kind: string; phase?: string; int: number; term: number; counts?: {analysis: number; ready: number; failure: number}}

async function fixture(t: TestContext, phase: Phase, kind: Kind, cleanupFails = false) {
  const directory = await makeTestDirectory("cli-publication-");
  const hashes = await writeCanonicalFixture(join(directory, "canonical"), manifest, input);
  const script = join(directory, "preload.mjs");
  await writeFile(script, preload(directory, {manifest: hashes.manifest, input, decision, configHash: hashes.config, policyHash: hashes.policy, triageHash: hashes.triage}, phase, kind, cleanupFails));
  const child = spawn(process.execPath, ["--experimental-test-module-mocks", "--import", script, cli], {
    env: {PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1"}, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = once(child, "close");
  const reached = Promise.withResolvers<Message>();
  const messages: Message[] = [];
  child.on("message", (message: Message) => {messages.push(message); if (message.kind === "ready") {reached.resolve(message);}});
  let stderr = ""; let stdout = "";
  child.stderr!.on("data", (bytes: Buffer) => {stderr += bytes.toString(); assert.ok(stderr.length < 16_384);});
  child.stdout!.on("data", (bytes: Buffer) => {stdout += bytes.toString(); assert.ok(stdout.length < 16_384);});
  const ready = async (): Promise<Message> => await Promise.race([reached.promise, closed.then((): never => {throw new Error(`CLI exited before ${phase}: ${stderr}`);})]);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");}
    await closed;
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, child, closed, ready, messages, stderr: () => stderr, stdout: () => stdout};
}

async function interrupt(run: Awaited<ReturnType<typeof fixture>>, first: "SIGINT" | "SIGTERM"): Promise<void> {
  assert.equal(run.child.kill(first), true);
  await new Promise<void>((resolve) => {setTimeout(resolve, 25);});
  assert.equal(run.child.kill(first === "SIGINT" ? "SIGTERM" : "SIGINT"), true);
  await new Promise<void>((resolve) => {setTimeout(resolve, 25);});
  run.child.send("continue");
}

for (const kind of ["analysis", "failure"] as const) {
  for (const phase of ["acquisition", "copy", "validation", "READY", "staging-cleanup", "staging-cleanup-return", "return", "finalization"] as const) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      test(`actual CLI ${signal} during ${kind} ${phase} revokes READY through finalization`, {timeout: 15_000}, async (t) => {
        const run = await fixture(t, phase, kind);
        assert.deepEqual(await run.ready(), {kind: "ready", phase, int: 1, term: 1});
        const started = performance.now();
        await interrupt(run, signal);
        assert.deepEqual(await run.closed, [signal === "SIGINT" ? 130 : 143, null], run.stderr());
        assert.ok(performance.now() - started < 2000);
        // Failure-envelope fixtures deliberately have a prior IMAGE_UNAVAILABLE
        // error. Its preservation must remain visible even after cancellation.
        const additional = kind === "failure" ? "SLITHER_CANCELLED_FINALIZATION: additional lifecycle failure; cleanup may be unconfirmed\n" : "";
        assert.equal(run.stderr(), `SLITHER_CANCELLED: ${signal}\n${additional}`);
        assert.equal(run.stdout(), "");
        await assert.rejects(readFile(join(run.directory, "output/READY")), {code: "ENOENT"});
        assert.deepEqual(run.messages.find((message) => message.kind === "exit"), {kind: "exit", counts: {analysis: 1, ready: kind === "analysis" ? 1 : 0, failure: kind === "failure" ? 1 : 0}, int: 0, term: 0});
      });
    }
  }
}

for (const kind of ["analysis", "failure"] as const) {
  test(`actual CLI final commit preserves normal ${kind} evidence`, async (t) => {
    const run = await fixture(t, "happy", kind);
    assert.deepEqual(await run.closed, [kind === "analysis" ? 0 : 50, null], run.stderr());
    assert.equal(run.stderr(), "");
    assert.equal(await readFile(join(run.directory, "output/READY"), "utf8"), "");
    const value = JSON.parse(await readFile(join(run.directory, kind === "analysis" ? "output/evidence.json" : "output/environment-failure.json"), "utf8"));
    assert.deepEqual(kind === "analysis" ? value.result : {category: value.category, exitCode: value.exitCode}, kind === "analysis" ? {category: "clean", exitCode: 0} : {category: "environment-failure", exitCode: 50});
    assert.equal(run.messages.find((message) => message.kind === "exit")?.int, 0);
    assert.equal(run.messages.find((message) => message.kind === "exit")?.term, 0);
  });
}

test("actual CLI reports cancellation plus staging cleanup failure and revokes READY", async (t) => {
  const run = await fixture(t, "staging-cleanup", "analysis", true);
  await run.ready(); await interrupt(run, "SIGTERM");
  assert.deepEqual(await run.closed, [143, null], run.stderr());
  assert.match(run.stderr(), /SLITHER_CANCELLED: SIGTERM/u);
  assert.match(run.stderr(), /cleanup may be unconfirmed/u);
  await assert.rejects(readFile(join(run.directory, "output/READY")), {code: "ENOENT"});
});

for (const replace of ["marker", "directory"] as const) {
  test(`actual CLI preserves foreign ${replace} replacement after writer return`, async (t) => {
    const run = await fixture(t, "return", "analysis");
    await run.ready();
    const output = join(run.directory, "output");
    await rename(replace === "marker" ? join(output, "READY") : output, join(run.directory, "retained"));
    if (replace === "directory") {await mkdir(output, {mode: 0o700});}
    await writeFile(join(output, "READY"), "foreign", {mode: 0o600});
    await interrupt(run, "SIGINT");
    assert.deepEqual(await run.closed, [130, null], run.stderr());
    assert.match(run.stderr(), /cleanup may be unconfirmed/u);
    assert.equal(await readFile(join(output, "READY"), "utf8"), "foreign");
  });
}

for (const file of ["READY", "evidence.json"] as const) {
  test(`actual CLI finalization rejects ${file} replacement after writer return`, async (t) => {
    const run = await fixture(t, "return", "analysis");
    await run.ready();
    const path = join(run.directory, "output", file);
    await rename(path, join(run.directory, "retained"));
    await writeFile(path, "foreign", {mode: 0o600});
    run.child.send("continue");
    assert.deepEqual(await run.closed, [40, null], run.stderr());
    assert.match(run.stderr(), /SLITHER_GATE_FAILED/u);
    assert.equal(await readFile(path, "utf8"), "foreign");
    if (file !== "READY") {await assert.rejects(readFile(join(run.directory, "output/READY")), {code: "ENOENT"});}
  });
}
