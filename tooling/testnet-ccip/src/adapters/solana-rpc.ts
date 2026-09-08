import { SPL_TOKEN_PROGRAM } from "../domain/solana-mint.ts";
import type { SolanaMintEnvelope } from "../domain/solana-mint.ts";
import type { MintObservation, MintStateEvidence, SignedMintTransaction } from "../application/solana-journal.ts";
const GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Invalid Devnet evidence"); }
  return value as ObjectValue;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) { throw new Error("Invalid RPC integer"); }
  return value;
}
function encoded(value: unknown): string {
  if (typeof value !== "string" || !value || Buffer.from(value, "base64").toString("base64") !== value) {
    throw new Error("Invalid transaction encoding");
  }
  return value;
}
function mintEvidence(raw: unknown, intent: SolanaMintEnvelope, slot: number): MintStateEvidence {
  const response = object(raw);
  if (integer(object(response.context).slot) < slot) { throw new Error("Stale mint observation"); }
  const account = object(response.value), data = object(account.data), parsed = object(data.parsed);
  const info = object(parsed.info);
  if (account.owner !== SPL_TOKEN_PROGRAM || account.executable !== false || data.program !== "spl-token" ||
    data.space !== 82 || parsed.type !== "mint" || info.isInitialized !== true || info.decimals !== 9 ||
    info.supply !== "0" || info.mintAuthority !== intent.payer || info.freezeAuthority !== null) {
    throw new Error("Mint does not match initialization");
  }
  return { address: intent.mint, tokenProgram: SPL_TOKEN_PROGRAM, decimals: 9, supply: "0",
    mintAuthority: intent.payer, freezeAuthority: null };
}

function validError(value: unknown): boolean {
  return value === null || typeof value === "string" ||
    (typeof value === "object" && !Array.isArray(value));
}

/** Official Devnet only. Finality is observed through one configured HTTPS RPC, not a light client. */
export function createSolanaMintRpc(
  messageFromSigned: (bytes: string, intent: SolanaMintEnvelope) => string,
  fetcher: typeof fetch = globalThis.fetch,
): {
  observe(signed: SignedMintTransaction, intent: SolanaMintEnvelope): Promise<MintObservation>;
  broadcast(bytes: string): Promise<string>;
} {
  let sequence = 0;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const id = ++sequence;
    const response = await fetcher("https://api.devnet.solana.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(20_000), redirect: "error",
    });
    const body = object(await response.json());
    if (!response.ok || body.id !== id || body.jsonrpc !== "2.0" || "error" in body || !("result" in body)) {
      throw new Error("Devnet RPC unavailable");
    }
    return body.result;
  }
  async function chain(): Promise<void> {
    if (await rpc("getGenesisHash", []) !== GENESIS) { throw new Error("Wrong Solana cluster"); }
  }
  const transaction = (signature: string): Promise<unknown> => rpc("getTransaction", [signature,
    { encoding: "base64", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
  async function status(signature: string): Promise<unknown> {
    const result = object(await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]));
    if (!Array.isArray(result.value) || result.value.length !== 1) { throw new Error("Invalid signature response"); }
    return result.value[0];
  }
  async function absent(signed: SignedMintTransaction, signatureStatus: unknown): Promise<MintObservation> {
        if (signatureStatus !== null) { return { kind: "unknown" }; }
        const height = integer(await rpc("getBlockHeight", [{ commitment: "finalized" }]));
        const valid = object(await rpc("isBlockhashValid", [signed.blockhash, { commitment: "finalized" }]));
        if (typeof valid.value !== "boolean") { return { kind: "unknown" }; }
        const again = await transaction(signed.signature), statusAgain = await status(signed.signature);
        await chain();
        if (again !== null || statusAgain !== null) { return { kind: "unknown" }; }
        return { kind: BigInt(height) > BigInt(signed.lastValidBlockHeight) || !valid.value ? "expired" : "not-found" };
  }
  async function observe(signed: SignedMintTransaction, intent: SolanaMintEnvelope): Promise<MintObservation> {
    try {
      await chain();
      const found = await transaction(signed.signature);
      const signatureStatus = await status(signed.signature);
      if (found === null) { return await absent(signed, signatureStatus); }
      const tx = object(found), meta = object(tx.meta), state = object(signatureStatus);
      const slot = integer(tx.slot);
      if (state.confirmationStatus !== "finalized" || integer(state.slot) !== slot ||
        !Array.isArray(tx.transaction) || tx.transaction[1] !== "base64" ||
        encoded(tx.transaction[0]) !== signed.bytesBase64 || !("err" in meta) ||
        JSON.stringify(state.err) !== JSON.stringify(meta.err)) { return { kind: "unknown" }; }
      const messageBase64 = messageFromSigned(signed.bytesBase64, intent);
      const mintState = meta.err === null ? mintEvidence(await rpc("getAccountInfo", [intent.mint,
        { encoding: "jsonParsed", commitment: "finalized", minContextSlot: slot }]), intent, slot) : null;
      const again = object(await transaction(signed.signature));
      const statusAgain = object(await status(signed.signature));
      await chain();
      if (again.slot !== slot || JSON.stringify(again.transaction) !== JSON.stringify(tx.transaction) ||
        JSON.stringify(object(again.meta).err) !== JSON.stringify(meta.err) ||
        statusAgain.confirmationStatus !== "finalized" || statusAgain.slot !== slot ||
        JSON.stringify(statusAgain.err) !== JSON.stringify(meta.err)) { return { kind: "unknown" }; }
      if (!validError(meta.err)) {
        return { kind: "unknown" };
      }
      return { kind: "finalized", signature: signed.signature, messageBase64, slot: String(slot),
        err: meta.err === null ? null : { transactionError: meta.err }, mintState };
    } catch { return { kind: "unknown" }; }
  }
  async function broadcast(bytes: string): Promise<string> {
    encoded(bytes);
    await chain();
    const signature = await rpc("sendTransaction", [bytes,
      { encoding: "base64", skipPreflight: false, preflightCommitment: "finalized", maxRetries: 0 }]);
    if (typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature)) {
      throw new Error("Unknown Solana send outcome");
    }
    return signature;
  }
  return { observe, broadcast };
}
