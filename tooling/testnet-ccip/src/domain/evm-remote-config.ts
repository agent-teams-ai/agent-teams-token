import { nextRegistrationStep } from "./evm-registration.ts";
import type { RegistrationSnapshot, RegistrationTarget } from "./evm-registration.ts";
export const SOLANA_REMOTE = Object.freeze({ selector: "16423721717087811551",
  pool: "0xb8321e6d62f6fe4a77501339b6d5cc2cd1ded28bab512b8371b77c10a07b381f",
  token: "0x009d49372ba9140a49e384e7a023a8f5273e7b1b9f87033ceb5ce59c116e9002",
  capacity: "10000000000", rate: "1000000000" });
export interface RemoteRate { readonly enabled: boolean; readonly capacity: string; readonly rate: string }
export interface RemoteSnapshot {
  readonly registration: RegistrationSnapshot; readonly supported: boolean;
  readonly pools: readonly string[]; readonly token: string;
  readonly inbound: RemoteRate; readonly outbound: RemoteRate;
}
const word = (value: bigint): string => value.toString(16).padStart(64, "0");
/** Pinned 1.6.1 ABI: empty removals, one Solana chain, raw 32-byte Pool Config PDA and mint. */
export function remoteConfigCalldata(): string {
  const rate = [1n, BigInt(SOLANA_REMOTE.capacity), BigInt(SOLANA_REMOTE.rate)];
  return "0xe8a1da17" + [64n, 96n, 0n, 1n, 32n, BigInt(SOLANA_REMOTE.selector), 288n, 416n,
    ...rate, ...rate, 1n, 32n, 32n].map(word).join("") + SOLANA_REMOTE.pool.slice(2) +
    word(32n) + SOLANA_REMOTE.token.slice(2);
}
export function nextRemoteConfigStep(snapshot: RemoteSnapshot, target: RegistrationTarget): "complete" | "configure" {
  if (nextRegistrationStep(snapshot.registration, target).kind !== "complete") {
    throw new Error("Finalized token registration required");
  }
  if (typeof snapshot.supported !== "boolean") { throw new Error("Invalid chain support evidence"); }
  const rateMatches = (rate: RemoteRate): boolean => rate.enabled === true &&
    rate.capacity === SOLANA_REMOTE.capacity && rate.rate === SOLANA_REMOTE.rate;
  if (snapshot.supported) {
    if (snapshot.pools.length !== 1 || snapshot.pools[0]?.toLowerCase() !== SOLANA_REMOTE.pool ||
      snapshot.token.toLowerCase() !== SOLANA_REMOTE.token || !rateMatches(snapshot.inbound) || !rateMatches(snapshot.outbound)) {
      throw new Error("Conflicting remote chain configuration");
    }
    return "complete";
  }
  if (snapshot.pools.length !== 0 || snapshot.token !== "0x" ||
    [snapshot.inbound, snapshot.outbound].some(rate => rate.enabled !== false || rate.capacity !== "0" || rate.rate !== "0")) {
    throw new Error("Unexpected unconfigured chain state");
  }
  return "configure";
}
