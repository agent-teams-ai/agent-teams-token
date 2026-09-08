import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import type { RequestOptions } from "node:http";
import { LocalSolanaError } from "../domain/model.ts";
import type { RpcPort } from "../application/ports.ts";
import { array, assertLoopbackRpcUrl, integer, object, parseAccountState, parseFinalizedTransaction, parseTokenAccountState, string } from "./rpc-parsers.ts";

export class JsonRpcAdapter implements RpcPort {
  private id = 0;
  public async waitReady(rpcUrl: string, timeoutMs: number, signal: AbortSignal): Promise<{ readonly version: string; readonly genesisHash: string }> {
    const deadline = Date.now() + timeoutMs; let last = "not ready";
    while (Date.now() < deadline) {
      aborted(signal);
      try {
        const version = object(await this.call(rpcUrl, "getVersion", [], signal), "version"); aborted(signal);
        const genesisHash = await this.genesisHash(rpcUrl, signal); aborted(signal);
        return { version: string(version["solana-core"], "solana core version"), genesisHash };
      } catch (cause) {
        aborted(signal); last = cause instanceof Error ? cause.message : "unknown readiness error";
        await delay(200, undefined, { signal }).catch(() => {}); aborted(signal);
      }
    }
    throw new LocalSolanaError("SOLANA_RPC_READY_TIMEOUT", last);
  }
  public async waitProgramsReady(rpcUrl: string, programIds: readonly string[], timeoutMs: number, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeoutMs; let last = "programs not ready";
    while (Date.now() < deadline) {
      aborted(signal);
      try {
        const slot = integer(await this.call(rpcUrl, "getSlot", [{ commitment: "finalized" }], signal), "finalized slot"); aborted(signal);
        const accounts: Record<string, unknown>[] = [];
        for (const programId of programIds) {
          const envelope = object(await this.call(rpcUrl, "getAccountInfo", [programId, { encoding: "base64", commitment: "finalized" }], signal), "program account response"); aborted(signal);
          if (envelope.value === null) { throw new LocalSolanaError("SOLANA_PROGRAM_MISSING", `${programId} is absent from local genesis`); }
          accounts.push(object(envelope.value, "program account"));
        }
        if (slot >= 2 && accounts.every((account) => account.executable === true && account.owner === "BPFLoaderUpgradeab1e11111111111111111111111")) { return; }
        last = "local programs are not executable at a post-genesis finalized slot";
      } catch (cause) { aborted(signal); last = cause instanceof Error ? cause.message : "unknown program readiness error"; }
      await delay(100, undefined, { signal }).catch(() => {}); aborted(signal);
    }
    throw new LocalSolanaError("SOLANA_PROGRAM_READY_TIMEOUT", last);
  }
  public async genesisHash(rpcUrl: string, signal: AbortSignal): Promise<string> { const value = await this.call(rpcUrl, "getGenesisHash", [], signal); aborted(signal); return string(value, "genesis hash"); }
  public async mintAccount(rpcUrl: string, address: string, signal: AbortSignal) {
    const result = object(await this.call(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }], signal), "account response"); aborted(signal);
    if (result.value === null) { throw new LocalSolanaError("SOLANA_MINT_MISSING", "mint account is missing"); }
    return parseAccountState(result.value, address);
  }
  public async tokenAccount(rpcUrl: string, address: string, signal: AbortSignal) {
    const result = object(await this.call(rpcUrl, "getAccountInfo", [address, { encoding: "jsonParsed", commitment: "finalized" }], signal), "account response"); aborted(signal);
    if (result.value === null) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_MISSING", "token account is missing"); }
    return parseTokenAccountState(result.value, address);
  }
  public async tokenAccountAddress(rpcUrl: string, owner: string, mint: string, signal: AbortSignal): Promise<string> {
    const result = object(await this.call(rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "finalized" }], signal), "token accounts response"); aborted(signal);
    const accounts = array(result.value, "token accounts");
    if (accounts.length !== 1) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_COUNT", "expected exactly one associated token account"); }
    const entry = object(accounts[0], "token account entry"); const address = string(entry.pubkey, "token account address");
    const state = parseTokenAccountState(object(entry.account, "token account value"), address);
    if (state.owner !== owner || state.mint !== mint) { throw new LocalSolanaError("SOLANA_TOKEN_ACCOUNT_IDENTITY", "associated token account identity does not match owner and mint"); }
    return address;
  }
  public async latestBlockhash(rpcUrl: string, signal: AbortSignal): Promise<string> {
    const root = object(await this.call(rpcUrl, "getLatestBlockhash", [{ commitment: "processed" }], signal), "blockhash result"); aborted(signal);
    return string(object(root.value, "blockhash value").blockhash, "blockhash");
  }
  public async sendSignedTransaction(rpcUrl: string, bytes: Uint8Array, signal: AbortSignal): Promise<string> {
    aborted(signal);
    const encoded = Buffer.from(bytes).toString("base64"); aborted(signal);
    const signature = string(await this.call(rpcUrl, "sendTransaction", [encoded, { encoding: "base64", skipPreflight: true, preflightCommitment: "processed", maxRetries: 5 }], signal), "transaction signature"); aborted(signal);
    await this.waitSignature(rpcUrl, signature, signal); aborted(signal); return signature;
  }
  public async finalizedTransaction(rpcUrl: string, signature: string, signal: AbortSignal) {
    await this.waitSignature(rpcUrl, signature, signal); aborted(signal);
    const parsed = await this.call(rpcUrl, "getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }], signal); aborted(signal);
    const compiled = await this.call(rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 }], signal); aborted(signal);
    const genesis = await this.genesisHash(rpcUrl, signal); aborted(signal);
    return parseFinalizedTransaction(parsed, compiled, signature, genesis);
  }
  private async waitSignature(rpcUrl: string, signature: string, signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      aborted(signal);
      const root = object(await this.call(rpcUrl, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }], signal), "signature status response"); aborted(signal);
      const first = array(root.value, "signature statuses")[0];
      if (first !== null && object(first, "signature status").confirmationStatus === "finalized") { return; }
      await delay(200, undefined, { signal }).catch(() => {}); aborted(signal);
    }
    throw new LocalSolanaError("SOLANA_TRANSACTION_TIMEOUT", "transaction did not finalize");
  }
  private async call(rpcUrl: string, method: string, params: readonly unknown[], externalSignal: AbortSignal): Promise<unknown> {
    assertLoopbackRpcUrl(rpcUrl); aborted(externalSignal);
    const allowed = new Set(["getVersion", "getGenesisHash", "getSlot", "getAccountInfo", "getTokenAccountsByOwner", "getLatestBlockhash", "sendTransaction", "getSignatureStatuses", "getTransaction"]);
    if (!allowed.has(method)) { throw new LocalSolanaError("SOLANA_RPC_METHOD", `RPC method ${method} is not allowlisted`); }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10_000); const abort = () => controller.abort(externalSignal.reason); externalSignal.addEventListener("abort", abort, { once: true });
    try {
      const url = assertLoopbackRpcUrl(rpcUrl); const id = ++this.id;
      const body = await this.postDirect(url, JSON.stringify({ jsonrpc: "2.0", id, method, params }), controller.signal); aborted(externalSignal);
      let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new LocalSolanaError("SOLANA_RPC_RESPONSE", "RPC response is not valid JSON"); }
      const envelope = object(parsed, "RPC envelope");
      if (envelope.id !== id) { throw new LocalSolanaError("SOLANA_RPC_RESULT", "RPC response id does not correlate to request"); }
      if (envelope.error !== undefined) { throw new LocalSolanaError("SOLANA_RPC_ERROR", JSON.stringify(envelope.error).slice(0, 1_000)); }
      if (!("result" in envelope)) { throw new LocalSolanaError("SOLANA_RPC_RESULT", "RPC result is missing"); }
      return envelope.result;
    } catch (cause) { if (externalSignal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "fixture interrupted"); } throw cause;
    } finally { clearTimeout(timer); externalSignal.removeEventListener("abort", abort); }
  }

  private postDirect(url: URL, body: string, signal: AbortSignal): Promise<string> {
    const port = url.port === "" ? 80 : Number(url.port);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (cause: unknown) => { if (settled) {return;} settled = true; reject(cause instanceof LocalSolanaError ? cause : new LocalSolanaError("SOLANA_RPC_RESPONSE", cause instanceof Error ? cause.message : "RPC transport failed")); };
      // This fixture RPC must never inherit ambient proxy settings. Node 24's
      // `node:http` consults NODE_USE_ENV_PROXY/HTTP_PROXY unless proxyEnv is
      // explicitly disabled; use a direct, non-pooled socket as an additional
      // guard so the peer identity check always observes the owned validator.
      const options = { protocol: "http:", hostname: "127.0.0.1", port, path: "/", method: "POST", agent: false, proxyEnv: {}, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, signal } satisfies RequestOptions & { readonly proxyEnv: NodeJS.ProcessEnv };
      const request = httpRequest(options, (response) => {
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) { response.resume(); fail(new LocalSolanaError("SOLANA_RPC_RESPONSE", `RPC HTTP status ${response.statusCode ?? 0}`)); return; }
        let size = 0; const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => { size += Buffer.byteLength(chunk); if (size > 1_048_576) { response.destroy(); fail(new LocalSolanaError("SOLANA_RPC_RESPONSE", "RPC response body exceeds limit")); } else { chunks.push(Buffer.from(chunk)); } });
        response.on("end", () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks).toString("utf8")); } });
        response.on("error", fail);
      });
      request.on("socket", (socket) => {
        const verify = () => { if (socket.remoteAddress !== "127.0.0.1" || socket.remotePort !== port) { request.destroy(); fail(new LocalSolanaError("SOLANA_RPC_RESPONSE", "RPC socket peer is not the owned validator")); } };
        if (socket.connecting) {socket.once("connect", verify);} else {verify();}
      });
      request.on("error", fail);
      request.setTimeout(10_000, () => { request.destroy(); fail(new LocalSolanaError("SOLANA_RPC_RESPONSE", "RPC transport timed out")); });
      request.end(body);
    });
  }
}

function aborted(signal: AbortSignal): void { if (signal.aborted) { throw new LocalSolanaError("SOLANA_COMMAND_ABORTED", "fixture interrupted"); } }
