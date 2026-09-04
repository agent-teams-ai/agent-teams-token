import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeNoReplaceEvidence, nativePublication } from "./native-provenance-fixture.ts";
import { artifactInputs, approvedArtifact, roots as fixtureRoots } from "./raw-artifact-fixture.ts";
import { testOnlyNoReplaceDirectoryRename } from "./helpers/no-replace-directory-rename.ts";
import { nativeNoReplaceApprovalSha256 } from "../src/adapters/native-no-replace.ts";
import type { DeploymentRpc, RpcMethod } from "../src/application/ports.ts";
import { buildFeeQuote, buildStablePlan, type QuoteObservation } from "../src/application/builder.ts";
import { publishReadyLast, verifyBundle } from "../src/composition/index.ts";
import { canonicalJson, sha256Hex } from "../src/domain/identity.ts";

const hash = `0x${"a".repeat(64)}` as const;
const roots = { ...fixtureRoots, maximumHeadLag: "2" } as const;
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

test("matching synthetic native evidence fails all production verification entrypoints", async (context) => {
  context.mock.method(Date, "now", () => 120_000);
  const parent = await realpath(await mkdtemp(join(tmpdir(), "deployment-plan-policy-")));
  const plan = buildStablePlan(approvedArtifact, roots);
  const quote = buildFeeQuote(plan, observation, roots);
  const evidence = syntheticEvidence();
  let renamed = false;
  await assert.rejects(
    publishReadyLast({
      parent,
      bundleName: "synthetic",
      plan,
      quote,
      roots,
      expected: approvedArtifact,
      artifactInputs,
      nativeNoReplaceEvidenceBytes: Buffer.from(`${canonicalJson(evidence)}\n`),
      outputFaultInjection: {
        noReplaceDirectoryRename(): Promise<void> {
          renamed = true;
          return Promise.resolve();
        },
      },
    }),
    /tuple is not atomically approved/u,
  );
  assert.equal(renamed, false);
  assert.deepEqual(await readdir(parent), []);
  await assertVerifyRejectsSynthetic({ parent, plan, quote, evidence });
});

function syntheticEvidence() {
  const evidence = {
    ...nativeNoReplaceEvidence,
    compilerSha256: `0x${"e".repeat(64)}` as const,
    executableSha256: `0x${"f".repeat(64)}` as const,
  };
  evidence.approvalSha256 = nativeNoReplaceApprovalSha256(evidence);
  return evidence;
}

async function assertVerifyRejectsSynthetic(
  request: {
    readonly parent: string;
    readonly plan: ReturnType<typeof buildStablePlan>;
    readonly quote: ReturnType<typeof buildFeeQuote>;
    readonly evidence: ReturnType<typeof syntheticEvidence>;
  },
): Promise<void> {
  const publication = await publishReadyLast({
    ...nativePublication,
    parent: request.parent,
    bundleName: "valid",
    plan: request.plan,
    quote: request.quote,
    roots,
    expected: approvedArtifact,
    artifactInputs,
    outputFaultInjection: { noReplaceDirectoryRename: testOnlyNoReplaceDirectoryRename },
  });
  const evidenceBytes = Buffer.from(`${canonicalJson(request.evidence)}\n`);
  const ready = JSON.parse(Buffer.from(await publication.readCommitted("READY")).toString());
  ready.nativeNoReplaceEvidenceSha256 = sha256Hex(evidenceBytes);
  let rpcCalled = false;
  try {
    await assert.rejects(
      verifyBundle({
        publication: substitutedPublication(publication, evidenceBytes, ready),
        expectedQuoteSha256: publication.quoteSha256,
        roots,
        expected: approvedArtifact,
        artifactInputs,
        nowSeconds: 120n,
        rpc: sentinelRpc(() => { rpcCalled = true; }),
        creationInput: approvedArtifact.creationInput,
      }),
      /tuple is not atomically approved/u,
    );
    assert.equal(rpcCalled, false);
  } finally {
    await publication.close();
  }
}

function substitutedPublication(
  publication: Awaited<ReturnType<typeof publishReadyLast>>,
  evidenceBytes: Uint8Array,
  ready: unknown,
) {
  return {
    ...publication,
    readCommitted(name: string): Promise<Uint8Array> {
      if (name === "native-no-replace-evidence.v1.json") {
        return Promise.resolve(evidenceBytes);
      }
      if (name === "READY") {
        return Promise.resolve(Buffer.from(`${canonicalJson(ready)}\n`));
      }
      return publication.readCommitted(name);
    },
    assertCurrent(): Promise<void> {
      return Promise.reject(new Error("verification reached publication sentinel"));
    },
    close(): Promise<void> {
      return publication.close();
    },
  };
}

function sentinelRpc(onCall: () => void): DeploymentRpc {
  return {
    request(_method: RpcMethod): Promise<unknown> {
      onCall();
      return Promise.reject(new Error("verification reached RPC sentinel"));
    },
  };
}
