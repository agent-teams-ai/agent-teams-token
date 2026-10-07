import { isDeepStrictEqual } from "node:util";
import { capturePrepared, captureSigned } from "./solana-setup-operator.ts";
import type { OperatorSignPrepared } from "./solana-setup-operator.ts";
import type { NativeSolanaProvider } from "./test-sdk-admission.ts";
import type { PreparedTransaction, TestKeys } from "./solana-transaction-sdk.mjs";
import type { ReverseExpectation, FinalizedLookup, createReverseTransactionSdk } from "./solana-reverse-sdk.mjs";
import type { SignedSolanaTransaction, InspectedSolanaTransaction } from "../application/solana-transaction-journal.ts";

type Core = ReturnType<typeof createReverseTransactionSdk>;

/** Inspect raw signed bytes independently; callback metadata is never the comparison authority. */
export function checkReverseSigned(prepared: Readonly<PreparedTransaction>, signed: SignedSolanaTransaction,
  inspected: InspectedSolanaTransaction): SignedSolanaTransaction {
  if (inspected.messageBase64 !== prepared.messageBase64 || inspected.blockhash !== prepared.blockhash ||
    signed.blockhash !== inspected.blockhash || signed.signature !== inspected.signature ||
    signed.lastValidBlockHeight !== prepared.lastValidBlockHeight) { throw new Error("Signed reverse does not match preparation"); }
  return Object.freeze({ bytesBase64: signed.bytesBase64, signature: inspected.signature,
    blockhash: inspected.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight });
}

/** Finite private owner. Native signing and key references stay outside the unsigned SDK view. */
export function createReverseSigning(provider: NativeSolanaProvider, core: Core, healthy: () => void) {
  let captured: { prepared: Readonly<PreparedTransaction>; expected: ReverseExpectation; snapshot: FinalizedLookup } | undefined;
  let closing = false, acquired = false, used = false;
  let pending: Promise<SignedSolanaTransaction> | undefined;
  const assertOpen = (): void => { healthy(); if (closing) { throw new Error("Reverse signing attempt closing"); } };
  const build = (...args: Parameters<Core["build"]>): ReturnType<Core["build"]> => {
    assertOpen(); if (captured) { throw new Error("Reverse signing attempt already prepared"); }
    const [candidate, expected, latest, snapshot] = args;
    const frozenExpected = structuredClone(expected);
    if (frozenExpected.fixture) { Object.freeze(frozenExpected.fixture); }
    Object.freeze(frozenExpected);
    const validity = Object.freeze({ ...latest }), value = core.build(candidate, frozenExpected, validity, snapshot);
    // Copy native ALT objects; caller-owned PublicKeys/arrays must not change trusted signing state.
    const { PublicKey, AddressLookupTableAccount } = provider.web3, s = snapshot.lookupTable.state;
    const selected: FinalizedLookup = { slot: snapshot.slot, lookupTable: new AddressLookupTableAccount({
      key: new PublicKey(snapshot.lookupTable.key.toBase58()), state: { deactivationSlot: s.deactivationSlot,
        lastExtendedSlot: s.lastExtendedSlot, lastExtendedSlotStartIndex: s.lastExtendedSlotStartIndex,
        ...(s.authority ? { authority: new PublicKey(s.authority.toBase58()) } : {}),
        addresses: s.addresses.map(key => new PublicKey(key.toBase58())) },
    }) };
    const prepared = capturePrepared(value);
    core.inspectPrepared(prepared, frozenExpected, selected); assertOpen();
    captured = { prepared, expected: frozenExpected, snapshot: selected }; return value;
  };
  const acquireSigner = (keys: TestKeys): OperatorSignPrepared<ReverseExpectation> => {
    assertOpen(); if (acquired || !captured) { throw new Error("Reverse signer acquisition refused"); }
    if (keys.testOnly !== true || typeof keys.payerFile !== "string" || !keys.payerFile.trim() || keys.payerFile.includes("\0")) {
      throw new Error("Test-only reverse key reference required");
    }
    const savedKeys: TestKeys = Object.freeze({ testOnly: true, payerFile: keys.payerFile }), saved = captured;
    core.inspectPrepared(saved.prepared, saved.expected, saved.snapshot); acquired = true;
    return (prepared, expected) => {
      assertOpen(); if (used || !isDeepStrictEqual(capturePrepared(prepared), saved.prepared) ||
        !isDeepStrictEqual(expected, saved.expected)) { throw new Error("Reverse signing identity refused"); }
      core.inspectPrepared(saved.prepared, saved.expected, saved.snapshot); used = true;
      // The actual trusted sign work, including key IO, stays owned until drain finishes.
      pending = (async () => {
        try {
          const signed = captureSigned(await core.sign(saved.prepared, saved.expected, savedKeys, saved.snapshot));
          assertOpen(); return checkReverseSigned(saved.prepared, signed,
            core.inspectSigned(signed.bytesBase64, saved.expected, saved.snapshot));
        } catch { throw new Error("TEST reverse signing failed"); }
      })();
      return pending;
    };
  };
  const drain = async (): Promise<void> => {
    closing = true;
    if (pending) { await pending.catch(() => {}); }
    pending = undefined; captured = undefined;
  };
  return { build, acquireSigner, drain };
}
