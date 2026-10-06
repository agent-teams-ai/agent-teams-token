import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { encodeAllocationCommitment, encodeAllocationId } from "@agent-teams/supply/genesis-manifest";
import { loadPreparedProductionPackage, publishDeploymentFiles } from "@agent-teams/supply/deployment-files";
import { runLocalExecutionProof } from "../../../scripts/deployment/local-execution-proof.ts";
import { parseProductionAttempt, parseProductionExpectations, parseProductionObservation } from "../src/adapters/production-inputs.ts";
import { assessProductionPreflight } from "../src/application/production-preflight.ts";
import { keccak256 } from "../src/domain/identity.ts";
import { createRealProductionPackage, type RealProductionPackage } from "./helpers/real-production-package.ts";

type RpcFacts = Record<string, unknown>;
const isRpcFacts = (value: unknown): value is RpcFacts => value !== null && typeof value === "object" && !Array.isArray(value);

function transformRpcResult(context: TestContext, transform: (result: unknown) => unknown): void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(IncomingMessage.prototype, Symbol.asyncIterator);
  const iterateRpcResponse = IncomingMessage.prototype[Symbol.asyncIterator];
  // Pinned Node's mock.method cannot restore Symbol keys. Restore the exact own
  // descriptor, or remove the shadow when the iterator was inherited.
  context.after(() => {
    if (originalDescriptor) { Object.defineProperty(IncomingMessage.prototype, Symbol.asyncIterator, originalDescriptor); }
    else { assert.ok(Reflect.deleteProperty(IncomingMessage.prototype, Symbol.asyncIterator)); }
  });
  Object.defineProperty(IncomingMessage.prototype, Symbol.asyncIterator, {
    configurable: true, enumerable: originalDescriptor?.enumerable ?? false, writable: true,
    value: async function* (this: IncomingMessage) {
      const chunks: Buffer[] = [];
      const iterator: AsyncIterableIterator<unknown> = iterateRpcResponse.call(this);
      for await (const chunk of { [Symbol.asyncIterator]: () => iterator }) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
      const envelope: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.ok(isRpcFacts(envelope));
      envelope.result = transform(envelope.result);
      yield Buffer.from(JSON.stringify(envelope), "utf8");
    },
  });
}

async function readBufferedResponse(body: string): Promise<string> {
  const socket = new Socket();
  const response = new IncomingMessage(socket);
  try {
    response.push(Buffer.from(body, "utf8"));
    response.push(null);
    const chunks: Buffer[] = [];
    for await (const chunk of response) {
      assert.ok(Buffer.isBuffer(chunk));
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    response.destroy();
    socket.destroy();
  }
}

for (const ownProperty of [false, true]) {
for (const rejecting of [false, true]) {
test(`HTTP fixture restores ${ownProperty ? "own descriptor" : "inherited iterator"} after ${rejecting ? "rejection" : "success"}`, async context => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(IncomingMessage.prototype, Symbol.asyncIterator);
  if (ownProperty) {
    Object.defineProperty(IncomingMessage.prototype, Symbol.asyncIterator, {
      configurable: true, enumerable: true, writable: false, value: IncomingMessage.prototype[Symbol.asyncIterator],
    });
    context.after(() => {
      if (originalDescriptor) { Object.defineProperty(IncomingMessage.prototype, Symbol.asyncIterator, originalDescriptor); }
      else { assert.ok(Reflect.deleteProperty(IncomingMessage.prototype, Symbol.asyncIterator)); }
    });
  }
  const expectedDescriptor = Object.getOwnPropertyDescriptor(IncomingMessage.prototype, Symbol.asyncIterator);
  const rejection = new Error("EXPLICIT_RPC_TRANSFORM_REJECTION");
  await context.test("intercepted response", async child => {
    transformRpcResult(child, result => { if (rejecting) { throw rejection; } return { received: result }; });
    const response = readBufferedResponse('{"result":"real buffered bytes"}');
    if (rejecting) { await assert.rejects(response, error => error === rejection); }
    else { assert.equal(await response, '{"result":{"received":"real buffered bytes"}}'); }
  });
  assert.equal(await readBufferedResponse("unrelated plaintext after interception\n"), "unrelated plaintext after interception\n");
  assert.deepEqual(Object.getOwnPropertyDescriptor(IncomingMessage.prototype, Symbol.asyncIterator), expectedDescriptor);
});
}
}

for (const pendingIndex of [false, true]) {
test(pendingIndex
  ? "authenticated Anvil proof accepts receipt-bound inclusion when the hash index offers the observed pending view"
  : "authenticated Anvil executes the four prepared operations and existing preflight accepts the evidence", { timeout: 120_000 }, async context => {
  const includedTransactions: RpcFacts[] = [];
  if (pendingIndex) {
    // Replay the three null inclusion fields captured from pinned Anvil's pool
    // index. All sends, receipts, block transactions and preflight remain real.
    transformRpcResult(context, result => {
      if (!isRpcFacts(result)) { return result; }
      if (Array.isArray(result.transactions)) {
        includedTransactions.push(...result.transactions.filter(isRpcFacts));
      }
      if (typeof result.hash === "string" && typeof result.input === "string") {
        return { ...result, blockHash: null, blockNumber: null, transactionIndex: null };
      }
      return result;
    });
  }
  const repositoryRoot = resolve(".");
  const root = await mkdtemp("/tmp/agtmai-production-execution-");
  context.after(() => rm(root, { recursive: true, force: true }));
  let fixture: RealProductionPackage | undefined;
  const output = join(root, "observations");
  const beforeProof = BigInt(Math.floor(Date.now() / 1000));
  const result = await runLocalExecutionProof({
    repositoryRoot,
    outputDirectory: output,
    preparePackage: async ({ signerAddress, packageDirectory }) => {
      fixture = await createRealProductionPackage(repositoryRoot, packageDirectory, signerAddress as `0x${string}`);
    },
  });
  const afterProof = BigInt(Math.floor(Date.now() / 1000));
  assert.ok(fixture);
  assert.deepEqual(result.operationCount, 4);
  const observationBytes = await readFile(join(output, "production-observation-v2.json"));
  assert.equal(await readFile(join(output, "READY"), "utf8"), `${keccak256(observationBytes)}\n`);
  const raw = observationBytes.toString("utf8");
  assert.doesNotMatch(raw, /private.?key|mnemonic|seed phrase/i);
  const replayDirectory = join(root, "preflight-package");
  const expectationsPath = join(root, "expectations.json"), attemptPath = join(root, "attempt.json");
  await Promise.all([
    publishDeploymentFiles(replayDirectory, fixture.files),
    writeFile(expectationsPath, fixture.expectations, {mode: 0o600}),
    writeFile(attemptPath, fixture.attempt, {mode: 0o600}),
  ]);
  const prepared = await loadPreparedProductionPackage(replayDirectory);
  const expectationsSource = new TextDecoder().decode(fixture.expectations);
  const attemptSource = new TextDecoder().decode(fixture.attempt);
  const deployment = prepared.configuration.deployment;
  const allocationHash = encodeAllocationCommitment({ network: { chainId: deployment.environment.evmChainId }, token: deployment.token }, deployment.allocations.map(allocation => ({ id: allocation.id, idBytes32: encodeAllocationId(allocation.id)!, recipient: allocation.recipient as `0x${string}`, amountBaseUnits: allocation.amountBaseUnits, ...(allocation.bps === undefined ? {} : { bps: allocation.bps }) }))).hash;
  const expectations = parseProductionExpectations(JSON.parse(expectationsSource));
  assert.equal(result.signerAddress, expectations.sender);
  assert.deepEqual(expectations.operations.map(operation => operation.nonce), ["7", "8", "9", "10"]);
  const observation = parseProductionObservation(JSON.parse(raw));
  if (pendingIndex) {
    assert.equal(includedTransactions.length, 4);
    for (const [index, transaction] of includedTransactions.entries()) {
      const operation = observation.operations[index]!;
      assert.equal(operation.transactionHash, transaction.hash);
      assert.equal(operation.blockHash, transaction.blockHash);
      assert.equal(operation.blockNumber, BigInt(transaction.blockNumber as string).toString());
      assert.equal(operation.transactionIndex, BigInt(transaction.transactionIndex as string).toString());
    }
  }
  const observedAt = BigInt(observation.observedAt);
  assert.ok(observedAt >= beforeProof && observedAt <= afterProof);
  for (const [index, operation] of observation.operations.entries()) {
    const timestamp = BigInt(operation.timestamp!);
    assert.ok(timestamp <= observedAt);
    assert.ok(timestamp <= BigInt(deployment.policy.executionDeadline));
    if (index > 0) {
      const previous = observation.operations[index - 1]!;
      assert.equal(BigInt(operation.blockNumber!), BigInt(previous.blockNumber!) + 1n);
      assert.ok(timestamp > BigInt(previous.timestamp!));
    }
    if (operation.id === "founder-fund") {
      assert.ok(timestamp <= BigInt(deployment.policy.fundingDeadline));
      assert.ok(timestamp + BigInt(deployment.policy.fundingLeadSeconds) <= BigInt(prepared.configuration.reserveGenesis.founder.schedule.start));
    }
  }
  const report = assessProductionPreflight({ prepared, expectations, observations: observation, attempt: parseProductionAttempt(JSON.parse(attemptSource)), nowSeconds: BigInt(observation.observedAt), preparedConfigurationSha256: prepared.configurationSha256, preparedReserveConfigurationSha256: prepared.reserveConfigurationSha256, preparedArtifactPinsSha256: expectations.artifactPinsSha256, expectedGenesisAllocationHash: allocationHash });
  assert.equal(report.status, "checks-passed-offline", JSON.stringify(report));
  assert.equal(report.broadcastAllowed, false);
  assert.deepEqual(report.reasons, []);
  assert.equal(observation.operations.map(operation => operation.id).join(","), "token-create,founder-reserve-create,controller-create,founder-fund");
  assert.equal(observation.state?.funding.caller, expectations.sender);
  assert.equal(observation.state?.controller.grossCommitted, "0");
  assert.equal(observation.state?.controller.rollingCommitted, "0");
  assert.equal(observation.state?.conservation.observedBalancesBaseUnits, "100000000000000000");
  assert.equal(observation.observedTotalCostWei, observation.operations.reduce((sum, operation) => sum + BigInt(operation.observedCostWei!), 0n).toString());
  assert.ok(observation.operations.every((operation, index) => operation.sender === expectations.sender && operation.nonce === (7n + BigInt(index)).toString() && BigInt(operation.gasUsed!) > 0n));
  assert.equal(observation.cleanup?.temporaryRootRemoved, true);
  const command = spawnSync(process.execPath, [resolve("tooling/deployment-plan/src/composition/production-preflight.ts"), "--prepared", replayDirectory, "--expectations", expectationsPath, "--observations", join(output, "production-observation-v2.json"), "--attempt-state", attemptPath], { cwd: repositoryRoot, encoding: "utf8" });
  assert.equal(command.status, 0, command.stdout + command.stderr);
  const commandReport = JSON.parse(command.stdout) as Record<string, unknown>;
  assert.equal(commandReport.status, "checks-passed-offline");
  assert.equal(commandReport.broadcastAllowed, false);
  assert.deepEqual(commandReport.unresolvedPrerequisites, [
    "Safe deployment and live authority observation",
    "contributor commitment execution",
    "authenticated live-chain evidence",
  ]);

});
}

test("unrelated plaintext stream is consumable after real successful Anvil interception", async () => {
  assert.equal(await readBufferedResponse("plaintext after actual successful proof\n"), "plaintext after actual successful proof\n");
});

test("public proof entrypoint rejects every external signer and prepared-package path", async () => {
  await assert.rejects(runLocalExecutionProof({ repositoryRoot: resolve("."), preparedDirectory: "/tmp/external-package", signerKeystorePath: "/tmp/external-key", signerPasswordPath: "/tmp/external-password", outputDirectory: "/tmp/unreachable", preparePackage: async () => {} } as never), /PROOF_EXTERNAL_SIGNER_OR_PACKAGE_INJECTION_UNSUPPORTED/);
  const command = spawnSync(process.execPath, [resolve("scripts/deployment/local-execution-proof.ts"), "--prepared", "/tmp/external-package", "--signer-keystore", "/tmp/external-key"], { encoding: "utf8" });
  assert.equal(command.status, 2);
  assert.match(command.stderr, /PROOF_IN_PROCESS_ORCHESTRATOR_REQUIRED/);
});

test("binding rejection retains the observed transaction and receipt without publishing success", { timeout: 120_000 }, async context => {
  const root = await mkdtemp("/tmp/agtmai-production-binding-diagnostic-");
  context.after(() => rm(root, { recursive: true, force: true }));
  const outputDirectory = join(root, "observations");
  let receipt: unknown;
  let tamperedTransaction: Record<string, unknown> | undefined;
  let transactionReads = 0;
  // Read the real owned Anvil response, then corrupt only its transaction view.
  // This is a negative transport fixture, not a reproduction of the CI failure.
  const corrupt = (transaction: RpcFacts): RpcFacts => {
      transactionReads += 1;
      tamperedTransaction = { ...transaction, blockHash: null };
      return tamperedTransaction;
  };
  transformRpcResult(context, result => {
    if (!isRpcFacts(result)) { return result; }
    if (typeof result.transactionHash === "string") { receipt = structuredClone(result); }
    if (typeof result.hash === "string" && typeof result.input === "string") { return corrupt(result); }
    if (Array.isArray(result.transactions)) {
      return { ...result, transactions: result.transactions.map(transaction => {
        return isRpcFacts(transaction) ? corrupt(transaction) : transaction;
      }) };
    }
    return result;
  });
  await assert.rejects(runLocalExecutionProof({
    repositoryRoot: resolve("."), outputDirectory,
    preparePackage: async ({ signerAddress, packageDirectory }) => {
      await createRealProductionPackage(resolve("."), packageDirectory, signerAddress as `0x${string}`);
    },
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "PROOF_TRANSACTION_BINDING");
    assert.ok(error.cause && typeof error.cause === "object");
    const facts = error.cause as { expected: { kind: string; sender: string; nonce: string; input: string }; transaction: unknown; receipt: unknown };
    assert.deepEqual(facts.transaction, tamperedTransaction);
    assert.deepEqual(facts.receipt, receipt);
    assert.equal(facts.expected.kind, "create");
    assert.equal(facts.expected.nonce, "7");
    assert.equal(facts.expected.sender, tamperedTransaction?.from);
    assert.equal(facts.expected.input, tamperedTransaction?.input);
    return true;
  });
  assert.equal(transactionReads, 1);
  await assert.rejects(lstat(join(outputDirectory, "READY")), { code: "ENOENT" });
});

test("proof ignores a valid package published outside its invocation-owned target", {timeout: 120_000}, async context => {
  const repositoryRoot = resolve(".");
  const root = await mkdtemp("/tmp/agtmai-production-external-package-");
  context.after(() => rm(root, {recursive: true, force: true}));
  const external = join(root, "external", "prepared");
  await mkdir(join(root, "external"), {mode: 0o700});
  await assert.rejects(runLocalExecutionProof({
    repositoryRoot,
    outputDirectory: join(root, "observations"),
    preparePackage: async ({signerAddress}) => {
      await createRealProductionPackage(repositoryRoot, external, signerAddress as `0x${string}`);
      return external as unknown as void;
    },
  }), (error: unknown) => (error as {code?: unknown}).code === "LOCAL_EVM_DIRECTORY_ENOENT");
  assert.ok(await loadPreparedProductionPackage(external));
});

test("receipt-bound block evidence fails closed on identity, inclusion, input, nonce and fee changes", { timeout: 120_000 }, async context => {
  const blockBinding = "PROOF_TRANSACTION_BLOCK_BINDING";
  const transactionBinding = "PROOF_TRANSACTION_BINDING";
  const wrongHash = `0x${"ff".repeat(32)}`;
  const cases: readonly { name: string; target: "receipt" | "block" | "transaction"; field: string; value: unknown; code: string }[] = [
    { name: "receipt hash differs from submitted hash", target: "receipt", field: "transactionHash", value: wrongHash, code: blockBinding },
    { name: "receipt index exceeds safe integer range", target: "receipt", field: "transactionIndex", value: "0x20000000000000", code: blockBinding },
    { name: "block hash differs from receipt", target: "block", field: "hash", value: wrongHash, code: blockBinding },
    { name: "block number differs from receipt", target: "block", field: "number", value: "0x2", code: blockBinding },
    { name: "selected transaction is absent", target: "block", field: "transactions", value: [], code: blockBinding },
    { name: "selected hash differs from submitted hash", target: "transaction", field: "hash", value: wrongHash, code: blockBinding },
    { name: "selected sender differs from prepared signer", target: "transaction", field: "from", value: `0x${"ff".repeat(20)}`, code: transactionBinding },
    { name: "selected nonce differs from prepared nonce", target: "transaction", field: "nonce", value: "0x8", code: transactionBinding },
    { name: "selected input differs from prepared initcode", target: "transaction", field: "input", value: "0x", code: transactionBinding },
    { name: "selected fee differs from prepared fee", target: "transaction", field: "maxFeePerGas", value: "0x1", code: "PROOF_TRANSACTION_FEE_BINDING" },
  ];
  for (const fixture of cases) {
    await context.test(fixture.name, async child => {
      const root = await mkdtemp("/tmp/agtmai-production-block-binding-");
      child.after(() => rm(root, { recursive: true, force: true }));
      const outputDirectory = join(root, "observations");
      let changes = 0;
      transformRpcResult(child, result => {
        if (!isRpcFacts(result)) { return result; }
        if (fixture.target === "receipt" && typeof result.transactionHash === "string") {
          changes += 1;
          return { ...result, [fixture.field]: fixture.value };
        }
        if (fixture.target === "receipt") { return result; }
        if (!Array.isArray(result.transactions) || !result.transactions.some(isRpcFacts)) { return result; }
        changes += 1;
        if (fixture.target === "block") { return { ...result, [fixture.field]: fixture.value }; }
        return { ...result, transactions: result.transactions.map(transaction => isRpcFacts(transaction)
          ? { ...transaction, [fixture.field]: fixture.value } : transaction) };
      });
      await assert.rejects(runLocalExecutionProof({
        repositoryRoot: resolve("."), outputDirectory,
        preparePackage: async ({ signerAddress, packageDirectory }) => {
          await createRealProductionPackage(resolve("."), packageDirectory, signerAddress as `0x${string}`);
        },
      }), { message: fixture.code });
      assert.equal(changes, 1);
      await assert.rejects(lstat(join(outputDirectory, "READY")), { code: "ENOENT" });
    });
  }
});

test("unrelated plaintext stream is consumable after real rejecting Anvil interceptions", async () => {
  assert.equal(await readBufferedResponse("plaintext after actual rejected proofs\n"), "plaintext after actual rejected proofs\n");
});
