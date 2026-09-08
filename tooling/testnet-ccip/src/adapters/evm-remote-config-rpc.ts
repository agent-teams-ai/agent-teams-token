import { readRegistrationSnapshot } from "./evm-registration-rpc.ts";
import { SOLANA_REMOTE } from "../domain/evm-remote-config.ts";
import type { RemoteRate, RemoteSnapshot } from "../domain/evm-remote-config.ts";
import type { RegistrationTarget } from "../domain/evm-registration.ts";
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
function words(value: unknown): string[] {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{64})+$/.test(value)) { throw new Error("Invalid remote ABI result"); }
  return value.slice(2).toLowerCase().match(/.{64}/g)!;
}
function rate(value: unknown): RemoteRate {
  const w = words(value), n = w.map(v => BigInt("0x" + v));
  if (n.length !== 5 || n[0]! >= 1n << 128n || n[1]! >= 1n << 32n || n[2]! > 1n ||
    n[3]! >= 1n << 128n || n[4]! >= 1n << 128n || n[0]! > n[3]!) { throw new Error("Invalid remote rate state"); }
  return { enabled: n[2] === 1n, capacity: n[3]!.toString(), rate: n[4]!.toString() };
}
/** All remote calls reuse the registry snapshot's finalized EIP-1898 hash. */
export async function readRemoteConfigSnapshot(target: RegistrationTarget, fetcher: typeof fetch = globalThis.fetch): Promise<RemoteSnapshot> {
  const registration = await readRegistrationSnapshot(target, fetcher);
  let id = 1000;
  async function rpc(method: string, params: unknown[]): Promise<unknown> {
    const sequence = ++id;
    const response = await fetcher("https://ethereum-sepolia-rpc.publicnode.com", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: sequence, method, params }),
      signal: AbortSignal.timeout(20_000), redirect: "error" });
    const body = await response.json() as { jsonrpc?: string; id?: number; error?: unknown; result?: unknown };
    if (!response.ok || !body || body.jsonrpc !== "2.0" || body.id !== sequence || "error" in body || !("result" in body)) {
      throw new Error("Remote config RPC unavailable");
    }
    return body.result;
  }
  const at = { blockHash: registration.finalizedBlockHash, requireCanonical: true };
  const call = (selector: string): Promise<unknown> => rpc("eth_call", [{ to: target.pool,
    data: selector + word(BigInt(SOLANA_REMOTE.selector)) }, at]);
  const supportedWords = words(await call("0x8926f54f"));
  if (supportedWords.length !== 1 || ![word(0n), word(1n)].includes(supportedWords[0]!)) { throw new Error("Invalid chain support ABI"); }
  const pools = words(await call("0xa42a7b8b"));
  // This product accepts only absent or exactly one raw 32-byte Solana pool; other shapes conflict.
  const emptyPools = [word(32n), word(0n)].join("");
  let remotePools: string[];
  if (pools.join("") === emptyPools) { remotePools = []; }
  else if (pools.length === 5 && pools.slice(0, 4).join("") === [32n, 1n, 32n, 32n].map(word).join("")) {
    remotePools = ["0x" + pools[4]!];
  } else { throw new Error("Conflicting remote pools ABI"); }
  const token = words(await call("0xb7946580"));
  let remoteToken: string;
  if (token.join("") === emptyPools) { remoteToken = "0x"; }
  else if (token.length === 3 && token[0] === word(32n) && token[1] === word(32n)) { remoteToken = "0x" + token[2]!; }
  else { throw new Error("Conflicting remote token ABI"); }
  const inbound = rate(await call("0xaf58d59f")), outbound = rate(await call("0xc75eea9c"));
  // A final canonical call prevents returning evidence after a mid-snapshot reorg.
  const recheck = await call("0x8926f54f");
  if (words(recheck).join("") !== supportedWords.join("") || await rpc("eth_chainId", []) !== "0xaa36a7") {
    throw new Error("Remote snapshot changed chain/block");
  }
  return { registration, supported: supportedWords[0] === word(1n), pools: remotePools, token: remoteToken, inbound, outbound };
}
