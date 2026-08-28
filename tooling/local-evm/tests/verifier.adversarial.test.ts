import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";
import { canonicalJson, keccak256, sha256, strip0x } from "../crypto.ts";
import { encodeConstructorArguments, reconstructCreationInput } from "../constructor.ts";
import { encodeAllocationCommitment, readApprovedManifest } from "../manifest.ts";
import { APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256, type ConstructorInputs, type DeploymentReport, type LocalManifest, type VerificationInput } from "../model.ts";
import type { RpcClient } from "../rpc.ts";
import { reconstructRuntime, verifyLocalDeployment, writeEvidence } from "../verifier.ts";
import { pinnedSolcPath } from "../toolchain.ts";

const execute = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const targetAddress = "0x9000000000000000000000000000000000000009" as const;
const deployerAddress = "0x9000000000000000000000000000000000000008" as const;
const transactionHash = `0x${"12".repeat(32)}` as const;
let creationInput: `0x${string}`;
let suiteRoot = "";
let manifestSource = "";
let buildSource = "";
let artifactSource = "";
let build: Record<string, unknown>;
let artifact: Record<string, unknown>;
let manifest: LocalManifest;

before(async () => {
  suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "agtmai-verifier-tests-")));
  const compiledRoot = join(suiteRoot, "compiled");
  manifestSource = await writeApprovedFixture(compiledRoot);
  manifest = JSON.parse(await readFile(manifestSource, "utf8")) as LocalManifest;
  const forgeOut = join(suiteRoot, "forge-out");
  const forgeBuildInfo = join(suiteRoot, "forge-build-info");
  await execute("forge", ["build", "--out", forgeOut, "--build-info", "--build-info-path", forgeBuildInfo, "--cache-path", join(suiteRoot, "forge-cache"), "--use", pinnedSolcPath(repositoryRoot)], {
    cwd: join(repositoryRoot, "contracts/evm"), timeout: 120_000, killSignal: "SIGKILL",
  });
  artifactSource = join(forgeOut, "AGTMAIToken.sol", "AGTMAIToken.json");
  const names = (await import("node:fs/promises")).readdir(forgeBuildInfo);
  const buildNames = (await names).filter((name) => name.endsWith(".json"));
  assert.equal(buildNames.length, 1);
  buildSource = join(forgeBuildInfo, buildNames[0]!);
  build = JSON.parse(await readFile(buildSource, "utf8")) as Record<string, unknown>;
  artifact = JSON.parse(await readFile(artifactSource, "utf8")) as Record<string, unknown>;
  creationInput = reconstructCreationInput(build, artifact, {
    schemaVersion: 1,
    initialSupplyBaseUnits: manifest.token.initialSupplyBaseUnits,
    allocations: manifest.allocations.map(({ idBytes32, recipient, amountBaseUnits }) => ({ idBytes32, recipient, amountBaseUnits })),
  });
}, { timeout: 120_000 });

after(async () => { await rm(suiteRoot, { recursive: true, force: true }); }, { timeout: 30_000 });

async function writeApprovedFixture(compiledRoot: string): Promise<string> {
  const source = {
    schemaVersion: 1, purpose: "local-fixture", status: "test-only",
    network: { kind: "local-evm", chainId: "31337" },
    token: { name: "Agent Teams AI", symbol: "AGTMAI", decimals: 9, initialSupplyBaseUnits: "1000000000000" },
    allocations: [
      { id: "test-alpha", recipient: "0x0000000000000000000000000000000000001001", amountBaseUnits: "400000000000", bps: 4000 },
      { id: "test-beta", recipient: "0x0000000000000000000000000000000000001002", amountBaseUnits: "350000000000", bps: 3500 },
      { id: "test-gamma", recipient: "0x0000000000000000000000000000000000001003", amountBaseUnits: "250000000000", bps: 2500 },
    ],
  } as const;
  const allocations = source.allocations.map((allocation) => ({
    ...allocation,
    idBytes32: `0x${Buffer.from(allocation.id, "ascii").toString("hex").padEnd(64, "0")}` as `0x${string}`,
  }));
  const base = {
    schemaVersion: 1 as const, purpose: "local-fixture-artifact" as const, status: "test-only" as const,
    network: source.network, token: source.token, allocations,
    sourceSha256: sha256(canonicalJson(source)),
    tool: { name: "@agent-teams/supply", feature: "genesis-manifest", version: "1" } as const,
  };
  const provisional = { ...base, rawAllocationAbi: "0x", genesisAllocationHash: "0x", localFixtureArtifactSha256: "0x" } as unknown as LocalManifest;
  const rawAllocationAbi = encodeAllocationCommitment(provisional);
  const withoutDigest = { ...base, rawAllocationAbi, genesisAllocationHash: keccak256(rawAllocationAbi) };
  const digest = sha256(Buffer.concat([
    Buffer.from("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0", "ascii"), Buffer.from(canonicalJson(withoutDigest)),
  ]));
  assert.equal(digest, APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256);
  const approved = { ...withoutDigest, localFixtureArtifactSha256: digest };
  const directory = join(compiledRoot, strip0x(digest));
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "manifest.json");
  await writeFile(manifestPath, canonicalJson(approved));
  await writeFile(join(directory, "READY"), canonicalJson({ sourceSha256: approved.sourceSha256, localFixtureArtifactSha256: digest }));
  return manifestPath;
}

interface CaseContext {
  readonly directory: string;
  readonly input: VerificationInput;
  readonly rpc: MockRpc;
  readonly paths: { readonly constructor: string; readonly deployment: string; readonly abi: string; readonly artifact: string; readonly build: string; readonly manifest: string; readonly ready: string };
}

class MockRpc implements RpcClient {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];
  chainId = "0x7a69";
  code = reconstructRuntime(build, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash);
  commitment: `0x${string}` = manifest.genesisAllocationHash;
  balances = new Map(manifest.allocations.map((allocation) => [allocation.recipient, allocation.amountBaseUnits]));
  transaction: Record<string, unknown> = { from: deployerAddress, to: null, input: creationInput };
  receipt: Record<string, unknown> = { contractAddress: targetAddress, to: null, transactionHash, status: "0x1" };

  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "eth_chainId") {return this.chainId;}
    if (method === "eth_getCode") {return this.code;}
    if (method === "eth_getTransactionByHash") {return this.transaction;}
    if (method === "eth_getTransactionReceipt") {return this.receipt;}
    if (method !== "eth_call") {throw new Error(`unexpected RPC method ${method}`);}
    const call = params[0] as { data: string };
    if (call.data === selector("name()")) {return abiString(manifest.token.name);}
    if (call.data === selector("symbol()")) {return abiString(manifest.token.symbol);}
    if (call.data === selector("decimals()")) {return word(String(manifest.token.decimals));}
    if (call.data === selector("totalSupply()") || call.data === selector("INITIAL_SUPPLY()")) {return word(manifest.token.initialSupplyBaseUnits);}
    if (call.data === selector("GENESIS_ALLOCATION_HASH()")) {return this.commitment;}
    if (call.data.startsWith(selector("balanceOf(address)"))) {
      const address = `0x${call.data.slice(-40)}`;
      return word(this.balances.get(address as `0x${string}`) ?? "0");
    }
    throw new Error(`unexpected eth_call ${call.data}`);
  }
}

async function makeCase(): Promise<CaseContext> {
  const directory = await mkdtemp(join(suiteRoot, "case-"));
  const artifactDirectory = join(directory, strip0x(APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256));
  await mkdir(artifactDirectory);
  const manifestPath = join(artifactDirectory, "manifest.json");
  const readyPath = join(artifactDirectory, "READY");
  await copyFile(manifestSource, manifestPath);
  await writeFile(readyPath, canonicalJson({ localFixtureArtifactSha256: APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256, sourceSha256: manifest.sourceSha256 }));
  const buildPath = join(directory, "build-info.json");
  const artifactPath = join(directory, "AGTMAIToken.json");
  const abiPath = join(directory, "AGTMAIToken.abi.json");
  const approvalPath = join(directory, "approved-build-profile.v1.json");
  await Promise.all([
    copyFile(buildSource, buildPath), copyFile(artifactSource, artifactPath),
    copyFile(join(repositoryRoot, "contracts/evm/abi/AGTMAIToken.abi.json"), abiPath),
    copyFile(join(repositoryRoot, "tooling/local-evm/approved-build-profile.v1.json"), approvalPath),
  ]);
  const constructorInputs: ConstructorInputs = {
    schemaVersion: 1,
    initialSupplyBaseUnits: manifest.token.initialSupplyBaseUnits,
    allocations: manifest.allocations.map(({ idBytes32, recipient, amountBaseUnits }) => ({ idBytes32, recipient, amountBaseUnits })),
  };
  const constructorPath = join(directory, "constructor-inputs.v1.json");
  const constructorBytes = Buffer.from(canonicalJson(constructorInputs));
  await writeFile(constructorPath, constructorBytes);
  const deployment: DeploymentReport = {
    schemaVersion: 1, chainId: "31337", targetAddress, transactionHash, deployerAddress, factoryAddress: null,
    creationInputSha256: sha256(creationInput), localFixtureArtifactSha256: APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256,
    buildInfoSha256: sha256(await readFile(buildPath)), contractArtifactSha256: sha256(await readFile(artifactPath)), constructorInputsSha256: sha256(constructorBytes),
  };
  const deploymentPath = join(directory, "deployment-report.v1.json");
  const deploymentBytes = Buffer.from(canonicalJson(deployment));
  await writeFile(deploymentPath, deploymentBytes);
  const input: VerificationInput = {
    rpcUrl: "http://127.0.0.1:8545/", manifestPath, readyPath, approvedArtifactSha256: APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256,
    buildInfoPath: buildPath, expectedBuildInfoSha256: deployment.buildInfoSha256,
    contractArtifactPath: artifactPath, expectedContractArtifactSha256: deployment.contractArtifactSha256,
    abiPath, expectedAbiSha256: sha256(await readFile(abiPath)), approvedBuildProfilePath: approvalPath,
    expectedApprovedBuildProfileSha256: sha256(await readFile(approvalPath)), constructorInputsPath: constructorPath,
    expectedConstructorInputsSha256: deployment.constructorInputsSha256, deploymentReportPath: deploymentPath,
    expectedDeploymentReportSha256: sha256(deploymentBytes), targetAddress, deployerAddress,
    toolVersions: { node: process.version, pnpm: "11.24.0", forge: "1.8.0", cast: "1.8.0", anvil: "1.8.0", solc: "Version: 0.8.36+commit.8a079791.Linux.g++" }, reportOutputRoot: join(directory, "reports"), runId: "test-run",
  };
  return { directory, input, rpc: new MockRpc(), paths: { constructor: constructorPath, deployment: deploymentPath, abi: abiPath, artifact: artifactPath, build: buildPath, manifest: manifestPath, ready: readyPath } };
}

async function diagnostic(context: CaseContext): Promise<string> {
  return (await verifyLocalDeployment(context.input, context.rpc)).exit.code;
}

test("clean approved deployment is independently proven without trusting deployer observations", { timeout: 60_000 }, async () => {
  const context = await makeCase();
  const report = await verifyLocalDeployment(context.input, context.rpc);
  assert.equal(report.exit.code, "OK");
  assert.equal(report.checks.some((check) => check.id === "rpc-proven-direct-creation"), true);
  assert.equal(context.rpc.calls.some((call) => call.method === "eth_getTransactionByHash"), true);
  assert.equal(context.rpc.calls.some((call) => call.method === "eth_getTransactionReceipt"), true);
});

test("normalized evidence is identical across Linux and macOS solc identities", { timeout: 60_000 }, async () => {
  const linux = await makeCase();
  const macos = await makeCase();
  (macos.input.toolVersions as Record<string, string>).solc = "Version: 0.8.36+commit.8a079791.Darwin.appleclang";

  const linuxReport = await verifyLocalDeployment(linux.input, linux.rpc);
  const macosReport = await verifyLocalDeployment(macos.input, macos.rpc);

  assert.equal(linuxReport.exit.code, "OK");
  assert.equal(macosReport.exit.code, "OK");
  assert.notEqual(linuxReport.tools.solc, macosReport.tools.solc);
  assert.equal(linuxReport.normalizedEvidenceSha256, macosReport.normalizedEvidenceSha256);
});

test("failed evidence redacts every unvalidated free-form input from JSON and Markdown", { timeout: 60_000 }, async () => {
  const context = await makeCase();
  const sentinel = "never-leak-sensitive-sentinel";
  (context.input.toolVersions as Record<string, string>).untrusted = sentinel;
  (context.input as { runId: string }).runId = sentinel;

  const report = await verifyLocalDeployment(context.input, context.rpc);
  assert.equal(report.exit.code, "VERIFY_TOOL_VERSIONS_INVALID");
  assert.deepEqual(report.tools, {});
  assert.equal(report.volatile.runId, "failed-input-redacted");
  assert.equal(JSON.stringify(report).includes(sentinel), false);

  await mkdir(context.input.reportOutputRoot, { mode: 0o700 });
  const written = await writeEvidence(context.input, report);
  const [json, markdown] = await Promise.all([readFile(written.jsonPath, "utf8"), readFile(written.markdownPath, "utf8")]);
  assert.equal(`${JSON.stringify(written)}${json}${markdown}`.includes(sentinel), false);
});

test("wrong chain, forged target, balances, commitment and RPC creation proof are rejected", { timeout: 60_000 }, async () => {
  let context = await makeCase(); context.rpc.chainId = "0x1"; assert.equal(await diagnostic(context), "VERIFY_CHAIN_ID_MISMATCH");
  context = await makeCase(); (context.input as { targetAddress: string }).targetAddress = "0x9000000000000000000000000000000000000010"; assert.equal(await diagnostic(context), "VERIFY_DEPLOYMENT_REPORT_MISMATCH");
  context = await makeCase(); context.rpc.balances.set(manifest.allocations[0]!.recipient, "1"); assert.equal(await diagnostic(context), "VERIFY_ALLOCATION_BALANCE_MISMATCH");
  context = await makeCase(); context.rpc.commitment = `0x${"00".repeat(32)}`; assert.equal(await diagnostic(context), "VERIFY_COMMITMENT_MISMATCH");
  context = await makeCase(); context.rpc.transaction = { ...context.rpc.transaction, to: deployerAddress }; assert.equal(await diagnostic(context), "VERIFY_DIRECT_CREATION_MISMATCH");
});

test("a non-test artifact fails before any RPC access or possible broadcast", { timeout: 60_000 }, async () => {
  const context = await makeCase();
  const forged = JSON.parse(await readFile(context.paths.manifest, "utf8")) as Record<string, unknown>;
  forged.status = "accepted";
  await writeFile(context.paths.manifest, canonicalJson(forged));
  assert.equal(await diagnostic(context), "VERIFY_MANIFEST_PROFILE_INVALID");
  assert.equal(context.rpc.calls.length, 0);
});

test("a public RPC URL fails before any injected or real RPC access", { timeout: 60_000 }, async () => {
  const context = await makeCase();
  (context.input as { rpcUrl: string }).rpcUrl = "https://rpc.example.invalid/";
  assert.equal(await diagnostic(context), "VERIFY_PUBLIC_RPC_FORBIDDEN");
  assert.equal(context.rpc.calls.length, 0);
});

test("an unpinned recorded solc version fails before RPC access", { timeout: 60_000 }, async () => {
  const context = await makeCase();
  (context.input.toolVersions as Record<string, string>).solc = "Version: 0.8.35+commit.abcdef01.Linux.g++";
  assert.equal(await diagnostic(context), "LOCAL_EVM_SOLC_VERSION_MISMATCH");
  assert.equal(context.rpc.calls.length, 0);
});

test("forged ABI, build artifact, build-info and deployment report are rejected even with attacker-updated transport digests", { timeout: 60_000 }, async () => {
  let context = await makeCase();
  await writeFile(context.paths.abi, "[]");
  (context.input as { expectedAbiSha256: string }).expectedAbiSha256 = sha256("[]");
  assert.equal(await diagnostic(context), "VERIFY_BUILD_APPROVAL_MISMATCH");

  context = await makeCase();
  const forgedArtifact = JSON.parse(await readFile(context.paths.artifact, "utf8")) as Record<string, unknown>;
  forgedArtifact.abi = [];
  const forgedArtifactBytes = Buffer.from(JSON.stringify(forgedArtifact));
  await writeFile(context.paths.artifact, forgedArtifactBytes);
  (context.input as { expectedContractArtifactSha256: string }).expectedContractArtifactSha256 = sha256(forgedArtifactBytes);
  assert.equal(await diagnostic(context), "VERIFY_BUILD_APPROVAL_MISMATCH");

  context = await makeCase();
  const forgedBuild = JSON.parse(await readFile(context.paths.build, "utf8")) as Record<string, unknown>;
  forgedBuild.solcVersion = "0.8.35";
  const forgedBuildBytes = Buffer.from(JSON.stringify(forgedBuild));
  await writeFile(context.paths.build, forgedBuildBytes);
  (context.input as { expectedBuildInfoSha256: string }).expectedBuildInfoSha256 = sha256(forgedBuildBytes);
  await bindBuildDigestInDeployment(context, sha256(forgedBuildBytes));
  assert.equal(await diagnostic(context), "VERIFY_BUILD_PROFILE_MISMATCH");

  context = await makeCase();
  const forgedReferences = JSON.parse(await readFile(context.paths.build, "utf8")) as Record<string, unknown>;
  const immutableReferences = deployedReferences(forgedReferences).immutableReferences as Record<string, Array<{ start: number; length: number }>>;
  immutableReferences[Object.keys(immutableReferences)[0]!]![0]!.start += 1;
  const forgedReferencesBytes = Buffer.from(JSON.stringify(forgedReferences));
  await writeFile(context.paths.build, forgedReferencesBytes);
  (context.input as { expectedBuildInfoSha256: string }).expectedBuildInfoSha256 = sha256(forgedReferencesBytes);
  await bindBuildDigestInDeployment(context, sha256(forgedReferencesBytes));
  assert.equal(await diagnostic(context), "VERIFY_BUILD_IMMUTABLE_REFERENCES_MISMATCH");

  context = await makeCase();
  const deployment = JSON.parse(await readFile(context.paths.deployment, "utf8")) as Record<string, unknown>;
  deployment.factoryAddress = deployerAddress;
  const deploymentBytes = Buffer.from(canonicalJson(deployment));
  await writeFile(context.paths.deployment, deploymentBytes);
  (context.input as { expectedDeploymentReportSha256: string }).expectedDeploymentReportSha256 = sha256(deploymentBytes);
  assert.equal(await diagnostic(context), "VERIFY_DEPLOYMENT_REPORT_MISMATCH");
});

test("every constructor input is compared with the approved manifest", { timeout: 60_000 }, async () => {
  const mutations: Array<(value: { initialSupplyBaseUnits: string; allocations: Array<Record<string, string>> }) => void> = [
    (value) => { value.initialSupplyBaseUnits = "1"; },
  ];
  for (let index = 0; index < manifest.allocations.length; index += 1) {
    mutations.push(
      (value) => { value.allocations[index]!.idBytes32 = `0x${"ff".repeat(32)}`; },
      (value) => { value.allocations[index]!.recipient = targetAddress; },
      (value) => { value.allocations[index]!.amountBaseUnits = "1"; },
    );
  }
  for (const mutate of mutations) {
    const context = await makeCase();
    const constructor = JSON.parse(await readFile(context.paths.constructor, "utf8"));
    mutate(constructor);
    const bytes = Buffer.from(canonicalJson(constructor));
    await writeFile(context.paths.constructor, bytes);
    (context.input as { expectedConstructorInputsSha256: string }).expectedConstructorInputsSha256 = sha256(bytes);
    assert.equal(await diagnostic(context), "VERIFY_CONSTRUCTOR_INPUTS_MISMATCH");
  }
});

test("exact reconstructed creation input rejects unrelated initcode, trailing bytes and every constructor-word mutation", { timeout: 60_000 }, async () => {
  let context = await makeCase();
  context.rpc.transaction = { ...context.rpc.transaction, input: "0x60006000" };
  assert.equal(await diagnostic(context), "VERIFY_CREATION_INPUT_MISMATCH");

  context = await makeCase();
  context.rpc.transaction = { ...context.rpc.transaction, input: `${creationInput}00` };
  assert.equal(await diagnostic(context), "VERIFY_CREATION_INPUT_MISMATCH");

  context = await makeCase();
  const deployment = JSON.parse(await readFile(context.paths.deployment, "utf8")) as Record<string, unknown>;
  deployment.creationInputSha256 = `0x${"00".repeat(32)}`;
  const deploymentBytes = Buffer.from(canonicalJson(deployment));
  await writeFile(context.paths.deployment, deploymentBytes);
  (context.input as { expectedDeploymentReportSha256: string }).expectedDeploymentReportSha256 = sha256(deploymentBytes);
  assert.equal(await diagnostic(context), "VERIFY_CREATION_INPUT_MISMATCH");

  const constructorInputs = {
    schemaVersion: 1 as const,
    initialSupplyBaseUnits: manifest.token.initialSupplyBaseUnits,
    allocations: manifest.allocations.map(({ idBytes32, recipient, amountBaseUnits }) => ({ idBytes32, recipient, amountBaseUnits })),
  };
  const argumentsHex = strip0x(encodeConstructorArguments(constructorInputs));
  const argumentsStart = creationInput.length - argumentsHex.length;
  for (let offset = 0; offset < argumentsHex.length; offset += 64) {
    context = await makeCase();
    const character = creationInput[argumentsStart + offset]!;
    const replacement = character === "0" ? "1" : "0";
    const mutated = `${creationInput.slice(0, argumentsStart + offset)}${replacement}${creationInput.slice(argumentsStart + offset + 1)}`;
    context.rpc.transaction = { ...context.rpc.transaction, input: mutated };
    assert.equal(await diagnostic(context), "VERIFY_CREATION_INPUT_MISMATCH", `constructor word ${offset / 64}`);
  }
});

test("artifact creation bytecode must exactly equal build-info creation bytecode", () => {
  const forged = structuredClone(artifact);
  const bytecode = forged.bytecode as Record<string, unknown>;
  bytecode.object = `${String(bytecode.object)}00`;
  assert.throws(
    () => reconstructCreationInput(build, forged, {
      schemaVersion: 1,
      initialSupplyBaseUnits: manifest.token.initialSupplyBaseUnits,
      allocations: manifest.allocations.map(({ idBytes32, recipient, amountBaseUnits }) => ({ idBytes32, recipient, amountBaseUnits })),
    }),
    (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === "VERIFY_ARTIFACT_BUILD_CREATION_MISMATCH",
  );
});

test("runtime reconstruction requires the exact immutable set, valid bounds, no overlap and no links", { timeout: 60_000 }, () => {
  const expected = reconstructRuntime(build, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash);
  assert.match(expected, /^0x[0-9a-f]+$/);
  assert.notEqual(reconstructRuntime(build, artifact, "1", manifest.genesisAllocationHash), expected);
  assert.notEqual(reconstructRuntime(build, artifact, manifest.token.initialSupplyBaseUnits, `0x${"00".repeat(32)}`), expected);

  let forged = structuredClone(build); (deployedReferences(forged).immutableReferences as Record<string, unknown>).unknown = [{ start: 0, length: 32 }];
  assert.throws(() => reconstructRuntime(forged, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash), /reference set is not exact/);
  forged = structuredClone(build); const empty = deployedReferences(forged).immutableReferences as Record<string, unknown[]>; empty[Object.keys(empty)[0]!] = [];
  assert.throws(() => reconstructRuntime(forged, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash), /empty immutable reference/);
  forged = structuredClone(build); const refs = deployedReferences(forged).immutableReferences as Record<string, Array<{ start: number; length: number }>>; const ids = Object.keys(refs); refs[ids[0]!]![0]!.start = 999999;
  assert.throws(() => reconstructRuntime(forged, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash), /overlap or exceed runtime bounds/);
  forged = structuredClone(build); const overlap = deployedReferences(forged).immutableReferences as Record<string, Array<{ start: number; length: number }>>; const overlapIds = Object.keys(overlap); overlap[overlapIds[1]!]![0]!.start = overlap[overlapIds[0]!]![0]!.start;
  assert.throws(() => reconstructRuntime(forged, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash), /overlap or exceed runtime bounds/);
  forged = structuredClone(build); deployedReferences(forged).linkReferences = { source: { Library: [{ start: 0, length: 20 }] } };
  assert.throws(() => reconstructRuntime(forged, artifact, manifest.token.initialSupplyBaseUnits, manifest.genesisAllocationHash), /linked runtime cannot be proven/);
});

test("stale, partial, absent and symlink READY plus coherent wrong manifest fail closed", { timeout: 60_000 }, async () => {
  let context = await makeCase(); await writeFile(context.paths.ready, "{}"); assert.equal(await diagnostic(context), "VERIFY_READY_MISMATCH");
  context = await makeCase(); await rm(context.paths.ready); assert.match(await diagnostic(context), /READY_ENOENT$/);
  context = await makeCase(); await rm(context.paths.ready); await symlink(manifestSource, context.paths.ready); assert.match(await diagnostic(context), /READY_SYMLINK$/);
  context = await makeCase(); await link(context.paths.ready, join(context.directory, "READY-hardlink")); assert.match(await diagnostic(context), /READY_NOT_REGULAR$/);
  context = await makeCase();
  const alias = join(context.directory, "substituted-parent");
  await symlink(context.directory, alias, "dir");
  await assert.rejects(readApprovedManifest(
    join(alias, strip0x(APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256), "manifest.json"),
    join(alias, strip0x(APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256), "READY"),
    APPROVED_LOCAL_FIXTURE_ARTIFACT_SHA256,
  ), (cause: unknown) => cause instanceof Error && "code" in cause
    && typeof cause.code === "string" && cause.code.endsWith("_PATH_SUBSTITUTION"));

  const wrong = structuredClone(manifest) as LocalManifest;
  (wrong.token as { initialSupplyBaseUnits: string }).initialSupplyBaseUnits = (BigInt(wrong.token.initialSupplyBaseUnits) + 1n).toString();
  (wrong.allocations[0] as { amountBaseUnits: string }).amountBaseUnits = (BigInt(wrong.allocations[0]!.amountBaseUnits) + 1n).toString();
  (wrong as { rawAllocationAbi: `0x${string}` }).rawAllocationAbi = encodeAllocationCommitment(wrong);
  (wrong as { genesisAllocationHash: `0x${string}` }).genesisAllocationHash = keccak256(wrong.rawAllocationAbi);
  const { localFixtureArtifactSha256: _ignored, ...withoutDigest } = wrong;
  const wrongDigest = sha256(Buffer.concat([Buffer.from("AGTMAI_LOCAL_FIXTURE_ARTIFACT_V1\0", "ascii"), Buffer.from(canonicalJson(withoutDigest))]));
  await assert.rejects(readApprovedManifest(context.paths.manifest, context.paths.ready, wrongDigest), /separately pinned committed local fixture/);
});

function selector(signature: string): string { return keccak256(signature).slice(0, 10); }
async function bindBuildDigestInDeployment(context: CaseContext, buildInfoSha256: `0x${string}`): Promise<void> {
  const deployment = JSON.parse(await readFile(context.paths.deployment, "utf8")) as Record<string, unknown>;
  deployment.buildInfoSha256 = buildInfoSha256;
  const bytes = Buffer.from(canonicalJson(deployment));
  await writeFile(context.paths.deployment, bytes);
  (context.input as { expectedDeploymentReportSha256: string }).expectedDeploymentReportSha256 = sha256(bytes);
}
function deployedReferences(value: Record<string, unknown>): Record<string, unknown> {
  return (((((value.output as Record<string, unknown>).contracts as Record<string, unknown>)["src/features/token-genesis/AGTMAIToken.sol"] as Record<string, unknown>).AGTMAIToken as Record<string, unknown>).evm as Record<string, unknown>).deployedBytecode as Record<string, unknown>;
}
function word(value: string): `0x${string}` { return `0x${BigInt(value).toString(16).padStart(64, "0")}`; }
function abiString(value: string): `0x${string}` {
  const bytes = Buffer.from(value);
  const padded = Buffer.alloc(Math.ceil(bytes.length / 32) * 32); bytes.copy(padded);
  return `0x${strip0x(word("32"))}${strip0x(word(String(bytes.length)))}${padded.toString("hex")}`;
}
