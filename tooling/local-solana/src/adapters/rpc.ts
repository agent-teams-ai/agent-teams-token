import { setTimeout as delay } from "node:timers/promises";
import { assertLoopbackRpcUrl, integer, LocalSolanaError, object, parseAccountState, parseTokenAccountState, string, type TransactionFact } from "../domain/model.ts";
import type { RpcPort } from "../application/ports.ts";

export class JsonRpcAdapter implements RpcPort {
  private id = 0;
  public async waitReady(rpcUrl: string, timeoutMs: number, signal: AbortSignal): Promise<{ readonly version: string; readonly genesisHash: string }> {
    const deadline = Date.now() + timeoutMs;
    let last = "not ready";
    while (Date.now() < deadline && !signal.aborted) {
      try {
        const version = object(await this.call(rpcUrl, "getVersion", []), "version");
        return { version: string(version["solana-core"], "solana core version"), genesisHash: await this.genesisHash(rpcUrl) };
      } catch (cause) { last = cause instanceof Error ? cause.message : "unknown readiness error"; await delay(200, undefined, { signal }).catch(() => {}); }
    }
    throw new LocalSolanaError("SOLANA_RPC_READY_TIMEOUT", last);
  }
  public async waitProgramsReady(rpcUrl: string, programIds: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = "programs not ready";
    while (Date.now() < deadline && !signal.aborted) {
      try {
        const slot = integer(await this.call(rpcUrl, "getSlot", [{ commitment: "finalized" }]), "finalized slot");
        const accounts = await Promise.all(programIds.map(async (programId) => {
          const envelope = object(await this.call(rpcUrl, "getAccountInfo", [programId, { encoding: "base64", commitment: "finalized" }]), "program account response");
          if (envelope.value === null) { throw new LocalSolanaError("SOLANA_PROGRAM_MISSING", `${programId} is absent from local genesis`); }
          return object(envelope.value, "program account");
        }));
        if (slot >= 2 && accounts.every((account) => account.executable === true && account.owner === "BPFLoaderUpgradeab1e11111111111111111111111")) { return; }
        last = "local programs are not executable at a post-genesis finalized slot";
      } catch (cause) { last = cause instanceof Error ? cause.message : "unknown program readiness error"; }
      await delay(100, undefined, { signal }).catch(() => {});
    }
    throw new LocalSolanaError("SOLANA_PROGRAM_READY_TIMEOUT", last);
  }
  public async genesisHash(rpcUrl: string): Promise<string> { return string(await this.call(rpcUrl, "getGenesisHash", []), "genesis hash"); }
  public async mintAccount(rpcUrl: string, address: string) {
    const result = object(await this.call(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }]), "account response");
    if (result.value === null) { throw new LocalSolanaError("SOLANA_MINT_MISSING", "mint account is missing"); }
    return parseAccountState(result.value, address);
  }
  public async tokenAccount(rpcUrl: string, address: string) {
    const result = object(await this.call(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }]), "account response");
    if (result.value === null) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_MISSING", "token account is missing"); }
    return parseTokenAccountState(result.value, address);
  }
  public async tokenAccountAddress(rpcUrl: string, owner: string, mint: string): Promise<string> {
    const result = object(await this.call(rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }]), "token accounts response");
    const accounts = array(result.value, "token accounts");
    if (accounts.length !== 1) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_COUNT", "expected exactly one associated token account"); }
    const entry = object(accounts[0], "token account entry"); const address = string(entry.pubkey, "token account address");
    const state = parseTokenAccountState(object(entry.account, "token account value"), address);
    if (state.owner !== owner || state.mint !== mint) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_IDENTITY", "associated token account identity does not match owner and mint"); }
    return address;
  }
  public async latestBlockhash(rpcUrl: string): Promise<string> {
    const root = object(await this.call(rpcUrl, "getLatestBlockhash", [{ commitment: "finalized" }]), "blockhash result");
    return string(object(root.value, "blockhash value").blockhash, "blockhash");
  }
  public async sendSignedTransaction(rpcUrl: string, bytes: Uint8Array): Promise<string> {
    const signature = string(await this.call(rpcUrl, "sendTransaction", [Buffer.from(bytes).toString("base64"), { encoding: "base64", skipPreflight: true, preflightCommitment: "finalized", maxRetries: 0 }]), "transaction signature");
    await this.waitSignature(rpcUrl, signature);
    return signature;
  }
  public async finalizedTransaction(rpcUrl: string, kind: TransactionFact["kind"], signature: string, genesisHash: string): Promise<TransactionFact> {
    await this.waitSignature(rpcUrl, signature);
    const raw = await this.call(rpcUrl, "getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    if (raw === null) { throw new LocalSolanaError("SOLANA_TRANSACTION_MISSING", `${kind} transaction is missing`); }
    const tx = object(raw, "transaction");
    const meta = object(tx.meta, "transaction meta");
    const message = object(object(tx.transaction, "transaction envelope").message, "transaction message");
    const instructions = array(message.instructions, "transaction instructions");
    const inner = meta.innerInstructions === null ? [] : array(meta.innerInstructions, "inner instructions").flatMap((entry) => array(object(entry, "inner instruction group").instructions, "inner instruction list"));
    const decoded = [...instructions, ...inner].map((entry) => decodeInstruction(entry));
    const blockTime = tx.blockTime;
    if (blockTime !== null) { integer(blockTime, "block time"); }
    return {
      kind, signature, slot: String(integer(tx.slot, "transaction slot")), confirmationStatus: "finalized", err: meta.err,
      programIds: [...new Set(decoded.map((item) => item.programId))], instructionKinds: decoded.map((item) => item.kind),
      amountBaseUnits: decoded.find((item) => item.amount !== null)?.amount ?? null, genesisHash,
    };
  }

  private async waitSignature(rpcUrl: string, signature: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const root = object(await this.call(rpcUrl, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]), "signature status response");
      const statuses = array(root.value, "signature statuses");
      const first = statuses[0];
      if (first !== null && object(first, "signature status").confirmationStatus === "finalized") { return; }
      await delay(200);
    }
    throw new LocalSolanaError("SOLANA_TRANSACTION_TIMEOUT", "transaction did not finalize");
  }

  private async call(rpcUrl: string, method: string, params: readonly unknown[]): Promise<unknown> {
    assertLoopbackRpcUrl(rpcUrl);
    const allowed = new Set(["getVersion", "getGenesisHash", "getSlot", "getAccountInfo", "getTokenAccountsByOwner", "getLatestBlockhash", "sendTransaction", "getSignatureStatuses", "getTransaction"]);
    if (!allowed.has(method)) { throw new LocalSolanaError("SOLANA_RPC_METHOD", `RPC method ${method} is not allowlisted`); }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(rpcUrl, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }), signal: controller.signal });
      if (!response.ok || response.url !== rpcUrl) { throw new LocalSolanaError("SOLANA_RPC_RESPONSE", `RPC HTTP status ${response.status}`); }
      const envelope = object(await response.json(), "RPC envelope");
      if (envelope.error !== undefined) { throw new LocalSolanaError("SOLANA_RPC_ERROR", JSON.stringify(envelope.error).slice(0, 1_000)); }
      if (!("result" in envelope)) { throw new LocalSolanaError("SOLANA_RPC_RESULT", "RPC result is missing"); }
      return envelope.result;
    } finally { clearTimeout(timer); }
  }
}

function decodeInstruction(value: unknown): { readonly programId: string; readonly kind: string; readonly amount: string | null } {
  const instruction = object(value, "instruction");
  const programId = string(instruction.programId, "instruction program ID");
  if (instruction.parsed === undefined) { return { programId, kind: "raw", amount: null }; }
  const parsed = object(instruction.parsed, "parsed instruction");
  const info = object(parsed.info, "instruction info");
  const amountValue = info.amount ?? (typeof info.tokenAmount === "object" && info.tokenAmount !== null ? object(info.tokenAmount, "instruction token amount").amount : undefined);
  const amount = typeof amountValue === "string" && /^(?:0|[1-9][0-9]*)$/u.test(amountValue) ? amountValue : null;
  return { programId, kind: string(parsed.type, "instruction type"), amount };
}

function array(value: unknown, label: string): readonly unknown[] { if (!Array.isArray(value)) { throw new LocalSolanaError("SOLANA_JSON_ARRAY", `${label} must be an array`); } return value; }
