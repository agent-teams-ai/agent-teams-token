import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseFeeQuote,
  parseJsonWithoutDuplicates,
  parseReadyMarker,
  parseStablePlan,
  parseTrustRoots,
} from "../src/adapters/strict-json.ts";

const hash = `0x${"a".repeat(64)}`;
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const observation = {
  chainId: "31337", blockNumber: "1", blockHash: hash, blockTimestamp: "1",
  currentHeadNumber: "1", currentHeadHash: hash, feeHistoryNewestBlock: "1",
  gasEstimate: "1", blockGasLimit: "2", baseFeePerGas: "1",
  maxPriorityFeePerGas: "1", maxFeePerGas: "2", observedAt: "1",
};
const identity = {
  contractFqn: "X.sol:X", buildProfile: "default", sourceDependencyClosure: {},
  buildInfoSha256: hash, artifactSha256: hash, abiSha256: hash, fixtureSha256: hash,
  fixtureReadySha256: hash, buildInfoSolcVersion: "0.8.36", compilerSettings: {},
  creationBytecodeHash: hash, constructorAbiBytes: "0x", constructorAbiHash: hash,
  constructorArguments: "0x", constructorArgumentsHash: hash, creationInputHash: hash,
  chainId: "31337", from: "0x0000000000000000000000000000000000000001",
  value: "0", capPolicy: { maximumWorstCaseWei: "1", testOnly: true },
  broadcastAllowed: false,
};
const plan = {
  schemaVersion: 1, kind: "deployment-plan", planId: hash, identity,
  broadcastAllowed: false, testOnly: true, productionApproved: false, mainnetAllowed: false,
};
const quote = {
  schemaVersion: 1, kind: "fee-quote", planId: hash, creationInputHash: hash,
  observation, bufferBps: "0", gasLimit: "1", effectiveFeePerGas: "2",
  estimatedWei: "2", worstCaseWei: "2", expiresAt: "2",
};
const ready = {
  schemaVersion: 1, planSha256: hash, quoteSha256: hash, planId: hash,
  creationInputHash: hash,
};

test("duplicate JSON members are rejected at every nesting level", () => {
  assert.throws(
    () => parseJsonWithoutDuplicates(Buffer.from('{"outer":{"x":1,"x":2}}')),
    /duplicate/u,
  );
});

test("plan, quote and READY parsers enforce exact keys and versions", () => {
  assert.doesNotThrow(() => parseStablePlan(bytes(plan)));
  assert.doesNotThrow(() => parseFeeQuote(bytes(quote)));
  assert.doesNotThrow(() => parseReadyMarker(bytes(ready)));
  assert.throws(() => parseStablePlan(bytes({ ...plan, signedRawTransaction: "0xdeadbeef" })), /unknown/u);
  assert.throws(() => parseFeeQuote(bytes({ ...quote, broadcastAllowed: true })), /unknown/u);
  assert.throws(() => parseReadyMarker(bytes({ ...ready, schemaVersion: 999 })), /schemaVersion/u);
  assert.throws(
    () => parseStablePlan(bytes({ ...plan, identity: { ...identity, sendMethod: "eth_sendRawTransaction" } })),
    /unknown/u,
  );
});

test("trust roots parser accepts only the committed exact local schema", async () => {
  const path = new URL("../trust-roots.v1.json", import.meta.url);
  const roots = await readFile(path);
  assert.equal(parseTrustRoots(roots).chainId, "31337");
  const parsed = JSON.parse(roots.toString()) as Record<string, unknown>;
  assert.throws(() => parseTrustRoots(bytes({ ...parsed, chainId: "1" })), /chainId/u);
  assert.throws(() => parseTrustRoots(bytes({ ...parsed, extra: true })), /unknown/u);
});
