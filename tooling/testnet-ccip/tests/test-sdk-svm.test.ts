import assert from "node:assert/strict";
import test from "node:test";
import { createSolanaMintSdk } from "../src/adapters/solana-sdk.mjs";
import { createSolanaPoolInitSdk } from "../src/adapters/solana-pool-init-sdk.mjs";
import { createSolanaRegistrationSdk } from "../src/adapters/solana-registration-sdk.mjs";
import { createSolanaPoolConfigSdk } from "../src/adapters/solana-pool-config-sdk.mjs";
import { createSolanaReverseSdk, type Candidate, type ReverseExpectation, type FinalizedLookup } from "../src/adapters/solana-reverse-sdk.mjs";
import { TEST_SDK_PROFILE, type TestSdkSelection } from "../src/adapters/test-sdk-policy.ts";
import { replacementFixture } from "../src/domain/replacement-fixture.ts";
import type { SolanaChain } from "../../../.local/INPUT/provider/node_modules/@chainlink/ccip-sdk/dist/solana/index.js";

const fixture = replacementFixture("0x812c4dcbc459a55f8517e87e825b8c728cee7316", "0x8472aa06661671e7e4af43048f0d0446eff2e97d");
const directory = "/absent-native-provider-sentinel";
const selection: TestSdkSelection = { providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture,
  fixtureIdentity: fixture.identity, providerArchives: "/absent-native-archives-sentinel" };
test("all native directory factories reject explicit invalid TEST selection before provider IO", async () => {
  for (const factory of [createSolanaMintSdk, createSolanaPoolInitSdk, createSolanaRegistrationSdk, createSolanaPoolConfigSdk]) {
    for (const providerProfile of [undefined, null, "", false, "unknown"]) {
      await assert.rejects(factory(directory, { ...selection, providerProfile }), /Unknown or non-TEST SDK profile/);
    }
    await assert.rejects(factory(directory, { ...selection, fixtureIdentity: "wrong" }), /fixture identity/);
    await assert.rejects(factory(directory, { ...selection, ccipProviderDirectory: "/other" }), /Divergent/);
    await assert.rejects(factory(directory), /ENOENT/);
  }
});
test("reverse requires injected transport and one TEST root before admission or journal access", async () => {
  const settings = { ...selection, providerDirectory: directory, ccipProviderDirectory: directory, recentSlot: "1" };
  await assert.rejects(createSolanaReverseSdk(settings), /injected unsigned transport/);
  await assert.rejects(createSolanaReverseSdk({ ...settings, providerProfile: null }), /Unknown or non-TEST/);
  await assert.rejects(createSolanaReverseSdk({ ...settings, ccipProviderDirectory: "/other" }), /Divergent/);
});

function contracts(chain: SolanaChain, candidate: Candidate, expected: ReverseExpectation, snapshot: FinalizedLookup,
  views: { reverse: Awaited<ReturnType<typeof createSolanaReverseSdk>>,
    mint: Awaited<ReturnType<typeof createSolanaMintSdk>>, config: Awaited<ReturnType<typeof createSolanaPoolConfigSdk>> }): void {
  const { reverse, mint, config } = views;
  // @ts-expect-error actual SDK requires bigint selector
  chain.getFee({ router: "x", destChainSelector: 1, message: { receiver: "x" } });
  // @ts-expect-error actual SDK requires bigint amount
  chain.generateUnsignedSendMessage({ sender: "x", router: "x", destChainSelector: 1n, message: { receiver: "x", tokenAmounts: [{ token: "x", amount: 1 }] } });
  // @ts-expect-error supplied candidate must carry the actual SDK family
  reverse.build({ instructions: candidate.instructions }, expected, { blockhash: "x", lastValidBlockHeight: "1" }, snapshot);
  // @ts-expect-error a candidate is not finalized snapshot authority
  reverse.build(candidate, expected, { blockhash: "x", lastValidBlockHeight: "1" });
  // @ts-expect-error finalized state carries the actual native lookup declaration
  const wrongState: Promise<{ lookupTable: string }> = reverse.state.before(async () => null, expected, "1");
  void wrongState;
  // @ts-expect-error the actual operator sign member is absent from unsigned worker views
  void mint.sign;
  // @ts-expect-error the actual reverse sign member is absent from unsigned worker views
  void reverse.sign;
  // @ts-expect-error no raw provider/signing constructor escapes the worker view
  reverse.native.web3.Keypair.fromSecretKey(new Uint8Array());
  // @ts-expect-error wrong concrete mint expectation
  mint.build({ payer: "x", mint: "y" }, { blockhash: "x", lastValidBlockHeight: "1" });
  if ('registrationVerifier' in config) {
    // @ts-expect-error the borrowed registration verifier never owns disposal
    void config.registrationVerifier.destroy;
    // @ts-expect-error the borrowed registration verifier has no signing member
    void config.registrationVerifier.sign;
  }
}
void contracts;
