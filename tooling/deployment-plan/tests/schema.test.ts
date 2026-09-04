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
import { canonicalJson, computePlanId, sha256Hex } from "../src/domain/identity.ts";

const hash = `0x${"a".repeat(64)}`;
const bytes = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const observation = {
  chainId: "31337", blockNumber: "1", blockHash: hash, blockTimestamp: "1",
  currentHeadNumber: "1", currentHeadHash: hash, feeHistoryNewestBlock: "1",
  senderNonce: "0", expectedCreateAddress: "0x522b3294e6d06aa25ad0f1b8891242e335d3b459", gasEstimate: "1", blockGasLimit: "2", baseFeePerGas: "1",
  maxPriorityFeePerGas: "1", maxFeePerGas: "2", observedAt: "1",
};
const identity = {
  contractFqn: "X.sol:X", buildProfile: "default", sourceDependencyClosure: {},
  rawBuildInfoSha256: hash, canonicalBuildInfoSha256: hash, compilerInputSha256: hash, artifactSha256: hash, abiSha256: hash, fixtureSha256: hash,
  fixtureReadySha256: hash, buildInfoSolcVersion: "0.8.36", compilerSettings: {},
  creationBytecodeHash: hash, constructorAbiBytes: "0x", constructorAbiHash: hash,
  constructorArguments: "0x", constructorArgumentsHash: hash, creationInput: "0x",
  creationInputHash: hash,
  chainId: "31337", from: "0x0000000000000000000000000000000000000001",
  value: "0", capPolicy: { maximumWorstCaseWei: "1", testOnly: true },
  broadcastAllowed: false,
};
const plan = {
  schemaVersion: 2, kind: "deployment-plan", planId: hash, identity,
  broadcastAllowed: false, testOnly: true, productionApproved: false, mainnetAllowed: false,
};
const quote = {
  schemaVersion: 2, kind: "fee-quote", planId: hash, creationInputHash: hash,
  observation, bufferBps: "0", gasLimit: "1", effectiveFeePerGas: "2",
  estimatedWei: "2", worstCaseWei: "2", expiresAt: "2",
};
const ready = {
  schemaVersion: 2, planSha256: hash, quoteSha256: hash, planId: hash,
  creationInputHash: hash,
};

test("strict JSON accepts only RFC 8259 whitespace and canonical integer tokens", () => {
  const valid = parseJsonWithoutDuplicates(
    Buffer.from(' \t\r\n{"positive":200,"negative":-27}\n'),
  ) as Record<string, unknown>;
  assert.equal(valid.positive, 200);
  assert.equal(valid.negative, -27);
  assert.equal(Object.getPrototypeOf(valid), null);
  for (const whitespace of ["\u00a0", "\u000b", "\u000c", "\u0085", "\u2028", "\ufeff"]) {
    assert.throws(
      () => parseJsonWithoutDuplicates(Buffer.from(`{${whitespace}"value":200}`)),
      /malformed JSON/u,
    );
  }
  for (const token of [
    "-0", "2e2", "200.0", "0200", "+200",
    "9007199254740992", "-9007199254740992",
  ]) {
    assert.throws(
      () => parseJsonWithoutDuplicates(Buffer.from(`{"value":${token}}`)),
      /malformed JSON/u,
    );
  }
});

test("plan, quote and trust-root fields remain semantically nonnegative", async () => {
  const roots = JSON.parse(
    await readFile(new URL("../trust-roots.v2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.throws(
    () => parseTrustRoots(bytes({ ...roots, maximumWorstCaseWei: "-27" })),
    /malformed/u,
  );
  assert.throws(
    () => parseStablePlan(bytes({
      ...plan,
      identity: {
        ...identity,
        capPolicy: { maximumWorstCaseWei: "-27", testOnly: true },
      },
    })),
    /malformed/u,
  );
  assert.throws(
    () => parseFeeQuote(bytes({ ...quote, gasLimit: "-27" })),
    /malformed/u,
  );
});

test("duplicate and prototype-named JSON members remain visible and fail closed", () => {
  for (const source of ['{"x":1,"x":2}', '{"outer":{"x":1,"x":2}}']) {
    assert.throws(() => parseJsonWithoutDuplicates(Buffer.from(source)), /duplicate/u);
  }

  const parsed = parseJsonWithoutDuplicates(
    Buffer.from('{"__proto__":{"constructor":1},"prototype":2}'),
  ) as Record<string, Record<string, unknown> | number>;
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.deepEqual(Object.keys(parsed), ["__proto__", "prototype"]);
  const nested = Object.getOwnPropertyDescriptor(
    parsed,
    "__proto__",
  )?.value as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(nested), null);
  assert.deepEqual(Object.keys(nested), ["constructor"]);

  const planBytes = JSON.stringify(plan);
  assert.throws(
    () => parseStablePlan(Buffer.from(planBytes.replace("{", '{"__proto__":{},'))),
    /unknown/u,
  );
  assert.throws(
    () => parseStablePlan(Buffer.from(planBytes.replace(
      '"identity":{',
      '"identity":{"constructor":{},"prototype":{},"__proto__":{},',
    ))),
    /unknown/u,
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
  for (const [field, value] of [
    ["senderNonce", "0"],
    ["expectedCreateAddress", "0x522b3294e6d06aa25ad0f1b8891242e335d3b459"],
    ["observedBlockNumber", "1"],
    ["observedBlockHash", hash],
  ] as const) {
    assert.throws(
      () => parseStablePlan(bytes({ ...plan, identity: { ...identity, [field]: value } })),
      /unknown/u,
    );
  }
  const { expectedCreateAddress: omitted, ...incompleteObservation } = observation;
  assert.equal(omitted.length, 42);
  assert.throws(
    () => parseFeeQuote(bytes({ ...quote, observation: incompleteObservation })),
    /missing/u,
  );
});

test("trust roots parser accepts only the committed exact local schema", async () => {
  const path = new URL("../trust-roots.v2.json", import.meta.url);
  const roots = await readFile(path);
  assert.equal(parseTrustRoots(roots).chainId, "31337");
  const parsed = JSON.parse(roots.toString()) as Record<string, unknown>;
  assert.throws(() => parseTrustRoots(bytes({ ...parsed, chainId: "1" })), /chainId/u);
  assert.throws(() => parseTrustRoots(bytes({ ...parsed, extra: true })), /unknown/u);
});

test("legacy V1 bytes fail closed and cannot enter the V2 identity domain", async () => {
  for (const [parse, value] of [
    [parseStablePlan, { ...plan, schemaVersion: 1 }],
    [parseFeeQuote, { ...quote, schemaVersion: 1 }],
    [parseReadyMarker, { ...ready, schemaVersion: 1 }],
  ] as const) {
    assert.throws(() => parse(bytes(value)), /V1 uses legacy numeric semantics/u);
  }
  const legacyRoots = await readFile(new URL("../trust-roots.v1.json", import.meta.url));
  assert.throws(() => parseTrustRoots(legacyRoots), /V1 uses legacy numeric semantics/u);

  const legacyId = sha256Hex(
    `AGTMAI_UNSIGNED_DEPLOYMENT_PLAN_V1\0${canonicalJson(identity)}`,
  );
  assert.notEqual(computePlanId(identity), legacyId);
});

test("every V2 decimal parser rejects values outside uint256", async () => {
  const overflow = (1n << 256n).toString();
  const roots = JSON.parse(
    await readFile(new URL("../trust-roots.v2.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  assert.throws(
    () => parseTrustRoots(bytes({ ...roots, maximumWorstCaseWei: overflow })),
    /outside uint256/u,
  );
  assert.throws(
    () => parseStablePlan(bytes({
      ...plan,
      identity: { ...identity, senderNonce: "0" },
    })),
    /unknown/u,
  );
  assert.throws(
    () => parseStablePlan(bytes({
      ...plan,
      identity: {
        ...identity,
        capPolicy: { maximumWorstCaseWei: overflow, testOnly: true },
      },
    })),
    /outside uint256/u,
  );
  assert.throws(
    () => parseFeeQuote(bytes({ ...quote, observation: { ...observation, senderNonce: overflow } })),
    /outside uint256/u,
  );
});
