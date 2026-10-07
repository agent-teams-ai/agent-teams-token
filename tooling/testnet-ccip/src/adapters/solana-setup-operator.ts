import { isDeepStrictEqual } from "node:util";
import type { NativeSolanaProvider } from "./test-sdk-admission.ts";
import type { BlockValidity, PreparedTransaction } from "./solana-transaction-sdk.mjs";
import type { SolanaMintIntent } from "../domain/solana-mint.ts";
import type { SignedSolanaTransaction } from "../application/solana-transaction-journal.ts";

export interface PreparedSetup<R> extends PreparedTransaction { readonly intent: SolanaMintIntent; readonly envelope: R }
export interface InspectedSetup<R> {
  readonly signature: string; readonly blockhash: string; readonly messageBase64: string;
  readonly intent: SolanaMintIntent; readonly envelope: R;
}
export type OperatorSignPrepared<E> = (prepared: Readonly<PreparedTransaction>, expected: Readonly<E>) => Promise<SignedSolanaTransaction>;
export interface OperatorAttempt<E, S, K> { readonly sdk: S; acquireSigner(keys: K): OperatorSignPrepared<E> }

/** Public transport strings only. Capture before crossing a callback await. */
export function capturePrepared(prepared: Readonly<PreparedTransaction>): Readonly<PreparedTransaction> {
  const copy = { bytesBase64: prepared.bytesBase64, messageBase64: prepared.messageBase64,
    blockhash: prepared.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight };
  if (Object.values(copy).some(value => typeof value !== "string" || !value)) { throw new Error("Invalid prepared setup transport"); }
  return Object.freeze(copy);
}
export function checkSetupSigned<R>(prepared: Readonly<PreparedTransaction>, signed: SignedSolanaTransaction,
  inspected: InspectedSetup<R>): SignedSolanaTransaction {
  if (inspected.messageBase64 !== prepared.messageBase64 || inspected.blockhash !== prepared.blockhash ||
    signed.blockhash !== inspected.blockhash || signed.signature !== inspected.signature ||
    signed.lastValidBlockHeight !== prepared.lastValidBlockHeight) { throw new Error("Signed setup does not match preparation"); }
  return Object.freeze({ bytesBase64: signed.bytesBase64, signature: inspected.signature,
    blockhash: inspected.blockhash, lastValidBlockHeight: prepared.lastValidBlockHeight });
}
export function captureSigned(signed: SignedSolanaTransaction): SignedSolanaTransaction {
  const copy = { bytesBase64: signed.bytesBase64, signature: signed.signature,
    blockhash: signed.blockhash, lastValidBlockHeight: signed.lastValidBlockHeight };
  if (Object.values(copy).some(value => typeof value !== "string" || !value)) { throw new Error("Invalid signed setup transport"); }
  return Object.freeze(copy);
}

function canonicalPrepared(prepared: Readonly<PreparedTransaction>, latest: Readonly<BlockValidity>) {
  const bytes = Buffer.from(prepared.bytesBase64, "base64"), message = Buffer.from(prepared.messageBase64, "base64");
  if (!bytes.length || bytes.length > 1232 || bytes.toString("base64") !== prepared.bytesBase64 ||
    !message.length || message.toString("base64") !== prepared.messageBase64 ||
    !/^[1-9][0-9]*$/.test(prepared.lastValidBlockHeight) || BigInt(prepared.lastValidBlockHeight) >= 1n << 64n ||
    prepared.lastValidBlockHeight !== latest.lastValidBlockHeight || prepared.blockhash !== latest.blockhash) {
    throw new Error("Invalid prepared setup packet");
  }
  return { bytes, message };
}

/** Use the admitted serializer/parser; validity height is authenticated metadata, never message data. */
export function checkSetupPrepared(provider: NativeSolanaProvider, prepared: Readonly<PreparedTransaction>,
  latest: Readonly<BlockValidity>, signers: readonly string[]) {
  const { bytes, message } = canonicalPrepared(prepared, latest);
  const tx = provider.web3.Transaction.from(bytes), compiled = tx.compileMessage();
  if (compiled.version !== "legacy" || tx.nonceInfo || !tx.recentBlockhash || tx.recentBlockhash !== prepared.blockhash ||
    !tx.serializeMessage().equals(message) ||
    !tx.serialize({ requireAllSignatures: false, verifySignatures: false }).equals(bytes) ||
    compiled.header.numRequiredSignatures !== signers.length || tx.signatures.length !== signers.length ||
    new Set(signers).size !== signers.length ||
    signers.some((s, i) => compiled.accountKeys[i]?.toBase58() !== s || tx.signatures[i]?.publicKey.toBase58() !== s) ||
    tx.signatures.some(s => s.signature !== null && s.signature.some(byte => byte !== 0))) {
    throw new Error("Invalid prepared setup message/signers");
  }
  return tx;
}

interface SigningCore<E, R, K> {
  build(expected: E, latest: BlockValidity): PreparedSetup<R>;
  inspectPrepared(prepared: PreparedTransaction, expected: E, latest: BlockValidity): void;
  inspectSigned(bytes: string, expected: E): InspectedSetup<R>;
  sign(prepared: PreparedTransaction, expected: E, keys: K): Promise<SignedSolanaTransaction>;
}
/** Finite private setup signing owner. No directory, provider, keys or disposer escapes on the SDK view. */
export function createSetupSigning<E extends object, R, K>(core: SigningCore<E, R, K>, healthy: () => void, close: () => void) {
  let captured: { prepared: Readonly<PreparedTransaction>; expected: E; latest: Readonly<BlockValidity> } | undefined;
  let closing = false, acquired = false, used = false;
  let pending: Promise<SignedSolanaTransaction> | undefined, closingPromise: Promise<void> | undefined;
  const assertOpen = (): void => { healthy(); if (closing) { throw new Error("Setup attempt is closing"); } };
  const build = (expected: E, latest: BlockValidity): PreparedSetup<R> => {
    assertOpen(); if (captured) { throw new Error("Setup attempt already prepared"); }
    const authenticated = Object.freeze({ ...latest }), frozenExpected = structuredClone(expected);
    if ("fixture" in frozenExpected && frozenExpected.fixture && typeof frozenExpected.fixture === "object") { Object.freeze(frozenExpected.fixture); }
    Object.freeze(frozenExpected);
    const value = core.build(frozenExpected, authenticated), prepared = capturePrepared(value);
    core.inspectPrepared(prepared, frozenExpected, authenticated); assertOpen();
    captured = { prepared, expected: frozenExpected, latest: authenticated }; return value;
  };
  const acquireSigner = (keys: K): OperatorSignPrepared<E> => {
    assertOpen(); if (acquired || !captured) { throw new Error("Setup signer acquisition refused"); }
    const saved = captured;
    core.inspectPrepared(saved.prepared, saved.expected, saved.latest); assertOpen(); acquired = true;
    return (prepared, expected) => {
      assertOpen(); if (used || !isDeepStrictEqual(capturePrepared(prepared), saved.prepared) ||
        !isDeepStrictEqual(expected, saved.expected)) { throw new Error("Setup signing identity refused"); }
      core.inspectPrepared(saved.prepared, saved.expected, saved.latest); used = true;
      const work = (async () => {
        try {
          const signed = captureSigned(await core.sign(saved.prepared, saved.expected, keys));
          assertOpen(); return checkSetupSigned(saved.prepared, signed, core.inspectSigned(signed.bytesBase64, saved.expected));
        } catch { throw new Error("TEST setup signing failed"); }
      })();
      pending = work;
      const settled = () => { pending = undefined; return null; };
      void work.then(settled, settled); return work;
    };
  };
  const destroy = (): Promise<void> => {
    if (closingPromise) { return closingPromise; }
    closing = true;
    const drain = (async () => { if (pending) { await pending.catch(() => {}); } close(); })();
    let timer: ReturnType<typeof setTimeout>;
    closingPromise = Promise.race([drain, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Unresolved TEST setup signing drain")), 20_000);
    })]).finally(() => clearTimeout(timer));
    return closingPromise;
  };
  return { build, acquireSigner, destroy, assertOpen };
}
