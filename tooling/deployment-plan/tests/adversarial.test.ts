import { nativePublication, nativeVerification, nativeNoReplacePolicy } from "./native-provenance-fixture.ts";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ApprovedArtifact } from "../src/adapters/artifact.ts";
import { parseFeeQuote } from "../src/adapters/strict-json.ts";
import { artifactInputs, approvedArtifact, roots as fixtureRoots } from "./raw-artifact-fixture.ts";
import type { DeploymentRpc, RpcMethod } from "../src/application/ports.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { independentlyVerify, independentlyVerifyRpc } from "../src/application/verifier.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";
import { computePlanId, deriveCreateAddress, sha256Hex } from "../src/domain/identity.ts";
import { main as estimateLocalMain } from "../../../scripts/deployment/estimate-local.ts";
import { testOnlyNoReplaceDirectoryRename } from "./helpers/no-replace-directory-rename.ts";

const hash = `0x${"a".repeat(64)}` as const;
const roots = { ...fixtureRoots, maximumHeadLag: "2" } as const;
const artifact = approvedArtifact;
const inputHash = artifact.creationInputHash;
const observation: QuoteObservation = {
  chainId: "31337",
  blockNumber: "10",
  blockHash: hash,
  blockTimestamp: "100",
  currentHeadNumber: "10",
  currentHeadHash: hash,
  feeHistoryNewestBlock: "10",
  senderNonce: "0",
  expectedCreateAddress: "0x522b3294e6d06aa25ad0f1b8891242e335d3b459",
  gasEstimate: "100",
  blockGasLimit: "1000",
  baseFeePerGas: "1",
  maxPriorityFeePerGas: "1",
  maxFeePerGas: "2",
  observedAt: "110",
};

test("production CLI rejects caller-supplied simulated time", async () => {
  await assert.rejects(estimateLocalMain(["--now", "1"]), /invalid.*--now/u);
});

test("wrong chain, head lag, future, stale, reorg and exact expiry fail", () => {
  const plan = buildStablePlan(artifact, roots);
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, chainId: "1" }, roots),
    /chain/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockNumber: "7" }, roots),
    /behind/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockNumber: "11" }, roots),
    /future/u,
  );
  assert.throws(
    () => buildFeeQuote(plan, { ...observation, blockTimestamp: "1" }, roots),
    /stale/u,
  );
  assert.throws(
    () => buildFeeQuote(
      plan,
      { ...observation, currentHeadHash: `0x${"b".repeat(64)}` },
      roots,
    ),
    /hash differs/u,
  );
  const quote = buildFeeQuote(plan, observation, roots);
  const ready = readyFor(plan.planId);
  assert.throws(
    () => independentlyVerify({ ...nativeVerification, plan, quote, roots, expected: artifact, artifactInputs, ready, nowSeconds: 170n }),
    /expiresAt/u,
  );
});

test("identity mutation, quote swapping and unsafe plan flags are rejected", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const changedArtifact = {
    ...artifact,
    rawBuildInfoSha256: `0x${"b".repeat(64)}` as const,
  };
  const changed = buildStablePlan(changedArtifact, roots);
  assert.notEqual(changed.planId, plan.planId);
  assert.throws(
    () => independentlyVerify({ ...nativeVerification,
      plan: changed,
      quote,
      roots,
      expected: changedArtifact, artifactInputs,
      ready: readyFor(changed.planId),
      nowSeconds: 120n,
    }),
    /bound|binding|mismatch|untrusted/u,
  );
  assert.throws(
    () => independentlyVerify({ ...nativeVerification,
      plan: { ...plan, broadcastAllowed: true } as never,
      quote,
      roots,
      expected: artifact, artifactInputs,
      ready: readyFor(plan.planId),
      nowSeconds: 120n,
    }),
    /safety/u,
  );
});

test("quotes cannot be cross-swapped between stable plans", () => {
  const firstPlan = buildStablePlan(artifact, roots);
  const otherRoots = { ...roots, maximumWorstCaseWei: "999999" } as const;
  const secondPlan = buildStablePlan(artifact, otherRoots);
  const firstQuote = buildFeeQuote(firstPlan, observation, roots);
  const secondQuote = buildFeeQuote(secondPlan, observation, otherRoots);
  assert.notEqual(firstPlan.planId, secondPlan.planId);
  assert.throws(
    () => independentlyVerify({ ...nativeVerification,
      plan: firstPlan,
      quote: secondQuote,
      roots,
      expected: artifact,
      artifactInputs,
      ready: readyFor(firstPlan.planId),
      nowSeconds: 120n,
    }),
    /not bound/u,
  );
  assert.doesNotThrow(() => independentlyVerify({ ...nativeVerification,
    plan: firstPlan,
    quote: firstQuote,
    roots,
    expected: artifact,
    artifactInputs,
    ready: readyFor(firstPlan.planId),
    nowSeconds: 120n,
  }));
});

test("volatile observations preserve stable identity and remain internally bound", async () => {
  const plan = buildStablePlan(artifact, roots);
  const quoteZero = buildFeeQuote(plan, observation, roots);
  const nextHash = `0x${"b".repeat(64)}` as const;
  const observationOne = {
    ...observation,
    senderNonce: "1",
    expectedCreateAddress: deriveCreateAddress(roots.from, 1n),
    blockNumber: "11",
    blockHash: nextHash,
    currentHeadNumber: "11",
    currentHeadHash: nextHash,
    feeHistoryNewestBlock: "11",
    gasEstimate: "101",
  };
  const quoteOne = buildFeeQuote(plan, observationOne, roots);
  assert.equal(quoteZero.planId, quoteOne.planId);
  assert.notDeepEqual(quoteZero, quoteOne);
  assert.throws(
    () => independentlyVerify({ ...nativeVerification,
      plan,
      quote: {
        ...quoteOne,
        observation: {
          ...observationOne,
          expectedCreateAddress: quoteZero.observation.expectedCreateAddress,
        },
      },
      roots,
      expected: artifact,
      artifactInputs,
      ready: readyFor(plan.planId),
      nowSeconds: 120n,
    }),
    /CREATE address/u,
  );
  await assert.rejects(
    independentlyVerifyRpc({ rpc, plan, quote: quoteOne, creationInput: artifact.creationInput }),
    /block|nonce|estimate changed/u,
  );
});

test("independent complete-input golden rejects coherent wrong bytecode and constructor input", () => {
  const wrongArguments = "0x04" as const;
  const wrongInput = "0x0104" as const;
  const coherentlyWrong: ApprovedArtifact = {
    ...artifact,
    constructorArguments: wrongArguments,
    constructorArgumentsHash: sha256Hex(Buffer.from("04", "hex")),
    creationInput: wrongInput,
    creationInputHash: sha256Hex(Buffer.from("0104", "hex")),
  };
  assert.throws(() => buildStablePlan(coherentlyWrong, roots), /golden/u);
  const wrongBytecode = "0x02" as const;
  const wrongBytecodeInput = "0x0203" as const;
  const coherentlyWrongBytecode: ApprovedArtifact = {
    ...artifact,
    creationBytecode: wrongBytecode,
    creationBytecodeHash: sha256Hex(Buffer.from("02", "hex")),
    creationInput: wrongBytecodeInput,
    creationInputHash: sha256Hex(Buffer.from("0203", "hex")),
  };
  assert.throws(() => buildStablePlan(coherentlyWrongBytecode, roots), /golden/u);
});

test("standalone verification rejects coherent non-local trust roots", () => {
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const unsafeRoots = { ...roots, chainId: "1" as never };
  const identity = { ...plan.identity, chainId: "1" };
  const unsafePlan = {
    ...plan,
    identity,
    planId: computePlanId(identity),
  };
  assert.throws(
    () => independentlyVerify({ ...nativeVerification,
      plan: unsafePlan,
      quote: { ...quote, planId: unsafePlan.planId, observation: { ...observation, chainId: "1" } },
      roots: unsafeRoots,
      expected: artifact, artifactInputs,
      ready: readyFor(unsafePlan.planId),
      nowSeconds: 120n,
    }),
    /local test-only/u,
  );
});

test("expiry at the final pre-publication check leaves no target or staging bundle", async (context) => {
  context.mock.method(Date, "now", () => 170_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-expiry-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  await assert.rejects(
    publishReadyLast({ ...nativePublication,
      parent,
      bundleName: "expired",
      plan,
      quote,
      roots,
      expected: artifact, artifactInputs,
    }),
    /expiresAt/u,
  );
  assert.deepEqual(await readdir(parent), []);
});

test("READY-last verifies held bytes and detects live estimate drift", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-test-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publication = await publishReadyLast({ ...nativePublication,
    parent,
    bundleName: "bundle",
    plan,
    quote,
    roots,
    expected: artifact,
    artifactInputs,
    outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename },
  });
  try {
    await verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput });
    assert.match(publication.quoteSha256, /^0x[0-9a-f]{64}$/u);
    assert.match(publication.identity.directoryDevice, /^[0-9]+$/u);
    assert.match(publication.identity.directoryInode, /^[0-9]+$/u);
    assert.deepEqual(await readdir(parent), ["bundle"]);
    const changedRpc: DeploymentRpc = {
      async request(method, params) {
        return method === "eth_estimateGas" ? "0x65" : rpc.request(method, params);
      },
    };
    await assert.rejects(
      verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc: changedRpc, creationInput: artifact.creationInput }),
      /estimate changed/u,
    );
    assert.deepEqual((await readdir(publication.directory)).toSorted(), [
      "READY", "deployment-plan.v2.json", "fee-quote.v2.json", "native-no-replace-evidence.v1.json",
    ]);
  } finally {
    await publication.close();
  }
});

test("same-plan quote substitution cannot replace the held approved quote", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-quote-swap-")));
  const plan = buildStablePlan(artifact, roots);
  const originalQuote = buildFeeQuote(plan, observation, roots);
  const replacementQuote = buildFeeQuote(plan, { ...observation, gasEstimate: "150" }, roots);
  assert.equal(originalQuote.worstCaseWei, "200");
  assert.equal(replacementQuote.worstCaseWei, "300");
  const options = { ...nativePublication, parent, plan, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } };
  const original = await publishReadyLast({ ...nativePublication, ...options, bundleName: "bundle", quote: originalQuote });
  const replacement = await publishReadyLast({ ...nativePublication, ...options, bundleName: "replacement", quote: replacementQuote });
  const displaced = join(parent, "original-held");
  try {
    assert.notEqual(original.quoteSha256, replacement.quoteSha256);
    await rename(original.directory, displaced);
    await rename(replacement.directory, original.directory);
    const heldQuote = parseFeeQuote(await original.readCommitted("fee-quote.v2.json"));
    assert.equal(heldQuote.worstCaseWei, "200");
    let rpcReads = 0;
    const observedRpc: DeploymentRpc = {
      async request(method, params) {
        rpcReads += 1;
        return rpc.request(method, params);
      },
    };
    await assert.rejects(
      verifyBundle({ nativeNoReplacePolicy, publication: original, expectedQuoteSha256: original.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc: observedRpc, creationInput: artifact.creationInput }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && error.code === "OUTPUT_PUBLISHED_SUBSTITUTED",
    );
    assert(rpcReads > 0, "live RPC verification must consume the held original quote before final path rejection");
  } finally {
    await original.close();
    await replacement.close();
  }
});

test("final-directory replacement before verification fails closed", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-directory-swap-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
  try {
    await rename(publication.directory, join(parent, "held-original"));
    await mkdir(publication.directory, { mode: 0o700 });
    await assert.rejects(
      verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
      /identity changed/u,
    );
  } finally {
    await publication.close();
  }
});

for (const substitutedName of ["READY", "deployment-plan.v2.json", "native-no-replace-evidence.v1.json"] as const) {
  test(`${substitutedName} substitution at the final verification boundary fails closed`, async (context) => {
    context.mock.method(Date, "now", () => 120_000);
    const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-final-leaf-")));
    const plan = buildStablePlan(artifact, roots);
    const quote = buildFeeQuote(plan, observation, roots);
    const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
    let substituted = false;
    const boundaryRpc: DeploymentRpc = {
      async request(method, params) {
        const result = await rpc.request(method, params);
        if (method === "eth_estimateGas" && !substituted) {
          substituted = true;
          const leaf = join(publication.directory, substitutedName);
          await unlink(leaf);
          await writeFile(leaf, "foreign", { mode: 0o600 });
        }
        return result;
      },
    };
    try {
      await assert.rejects(
        verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc: boundaryRpc, creationInput: artifact.creationInput }),
        /substituted|identity changed|regular file/u,
      );
      assert.equal(substituted, true);
    } finally {
      await publication.close();
    }
  });
}

for (const mutation of ["missing", "symlink", "hardlink"] as const) {
  test(`${mutation} native evidence is rejected by the held publication verifier`, async (context) => {
    context.mock.method(Date, "now", () => 120_000);
    const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-native-leaf-")));
    const plan = buildStablePlan(artifact, roots);
    const quote = buildFeeQuote(plan, observation, roots);
    const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
    const leaf = join(publication.directory, "native-no-replace-evidence.v1.json");
    const foreign = join(parent, "foreign-evidence");
    await writeFile(foreign, "foreign", { mode: 0o600 });
    await unlink(leaf);
    if (mutation === "symlink") await symlink(foreign, leaf);
    if (mutation === "hardlink") await link(foreign, leaf);
    try {
      await assert.rejects(verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }), /missing|substituted|regular file|identity changed/u);
    } finally { await publication.close(); }
  });
}

test("an extra bundle leaf is rejected", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-extra-leaf-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
  await writeFile(join(publication.directory, "extra"), "foreign", { mode: 0o600 });
  try {
    await assert.rejects(verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }), /foreign entry/u);
  } finally { await publication.close(); }
});

test("verification rejects an expected quote digest mismatch", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-digest-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
  try {
    await assert.rejects(
      verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: `0x${"f".repeat(64)}`, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
      /expected quote digest/u,
    );
  } finally {
    await publication.close();
  }
});

test("legacy leaf names cannot be verified through a publication capability", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-legacy-")));
  const plan = buildStablePlan(artifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const publication = await publishReadyLast({ ...nativePublication, parent, bundleName: "bundle", plan, quote, roots, expected: artifact, artifactInputs, outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename } });
  try {
    await rename(join(publication.directory, "deployment-plan.v2.json"), join(publication.directory, "deployment-plan.v1.json"));
    await assert.rejects(
      verifyBundle({ nativeNoReplacePolicy, publication, expectedQuoteSha256: publication.quoteSha256, roots, expected: artifact, artifactInputs, nowSeconds: 120n, rpc, creationInput: artifact.creationInput }),
      /foreign entry|substituted|identity changed/u,
    );
  } finally {
    await publication.close();
  }
});

function readyFor(planId: `0x${string}`) {
  return {
    schemaVersion: 3 as const,
    planSha256: hash,
    quoteSha256: hash,
    nativeNoReplaceEvidenceSha256: hash,
    planId,
    creationInputHash: inputHash,
  };
}

const rpc: DeploymentRpc = {
  async request(method: RpcMethod): Promise<unknown> {
    switch (method) {
      case "eth_chainId": return "0x7a69";
      case "eth_getBlockByNumber": return {
        number: "0xa", hash, timestamp: "0x64", gasLimit: "0x3e8", baseFeePerGas: "0x1",
      };
      case "eth_feeHistory": return { oldestBlock: "0xa", baseFeePerGas: ["0x1", "0x2"] };
      case "eth_getTransactionCount": return "0x0";
      case "eth_estimateGas": return "0x64";
    }
  },
};
