import { setTimeout as delay } from "node:timers/promises";
import { request as httpRequest } from "node:http";
import { LocalSolanaError } from "../domain/model.ts";
import type { RpcPort } from "../application/ports.ts";
import { array, assertLoopbackRpcUrl, integer, object, parseAccountState, parseFinalizedTransaction, parseTokenAccountState, string } from "./rpc-parsers.ts";

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
    // A processed hash is the validator's freshest hash. Failed transactions must
    // skip simulation so they reach the real program, which makes a fresh hash and
    // validator-side delivery retries especially important on a single-node cluster.
    const root = object(await this.call(rpcUrl, "getLatestBlockhash", [{ commitment: "processed" }]), "blockhash result");
    return string(object(root.value, "blockhash value").blockhash, "blockhash");
  }
  public async sendSignedTransaction(rpcUrl: string, bytes: Uint8Array): Promise<string> {
    const signature = string(await this.call(rpcUrl, "sendTransaction", [Buffer.from(bytes).toString("base64"), { encoding: "base64", skipPreflight: true, preflightCommitment: "processed", maxRetries: 5 }]), "transaction signature");
    await this.waitSignature(rpcUrl, signature);
    return signature;
  }
  public async finalizedTransaction(rpcUrl: string, signature: string) {
    await this.waitSignature(rpcUrl, signature);
    const raw = await this.call(rpcUrl, "getTransaction", [signature, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }]);
    return parseFinalizedTransaction(raw, signature, await this.genesisHash(rpcUrl));
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
      const url = assertLoopbackRpcUrl(rpcUrl);
      const id = ++this.id;
      const body = await this.postDirect(url, JSON.stringify({ jsonrpc: "2.0", id, method, params }), controller.signal);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new LocalSolanaError("SOLANA_RPC_RESPONSE", "RPC response is not valid JSON"); }
      const envelope = object(parsed, "RPC envelope");
      if (envelope.id !== id) { throw new LocalSolanaError("SOLANA_RPC_RESULT", "RPC response id does not correlate to request"); }
      if (envelope.error !== undefined) { throw new LocalSolanaError("SOLANA_RPC_ERROR", JSON.stringify(envelope.error).slice(0, 1_000)); }
      if (!("result" in envelope)) { throw new LocalSolanaError("SOLANA_RPC_RESULT", "RPC result is missing"); }
      return envelope.result;
    } finally { clearTimeout(timer); }
  }

  private postDirect(url: URL, body: string, signal: AbortSignal): Promise<string> {
    const port = Number(url.port);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (cause: unknown) => { if (settled) {return;} settled = true; reject(cause instanceof LocalSolanaError ? cause : new LocalSolanaError("SOLANA_RPC_RESPONSE", cause instanceof Error ? cause.message : "RPC transport failed")); };
      // This fixture RPC must never inherit ambient proxy settings. Node 24's
      // `node:http` consults NODE_USE_ENV_PROXY/HTTP_PROXY unless proxyEnv is
      // explicitly disabled; use a direct, non-pooled socket as an additional
      // guard so the peer identity check always observes the owned validator.
      const options = { protocol: "http:", hostname: "127.0.0.1", port, path: "/", method: "POST", agent: false, proxyEnv: {}, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }, signal } as Parameters<typeof httpRequest>[0];
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
