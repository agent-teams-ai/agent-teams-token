import { validateReplacementFixture } from "./replacement-fixture.ts";
import type { ReplacementFixture } from "./replacement-fixture.ts";
import { solanaPublicKeyBytes } from "./solana-mint.ts";
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
export function solanaRemote(fixture?: ReplacementFixture): typeof SOLANA_REMOTE | { selector: string; pool: string; token: string; capacity: string; rate: string } {
  if (fixture === undefined) { return SOLANA_REMOTE; }
  const f = validateReplacementFixture(fixture);
  return { ...SOLANA_REMOTE, pool: "0x" + solanaPublicKeyBytes(f.solanaPool).toString("hex"),
    token: "0x" + solanaPublicKeyBytes(f.mint).toString("hex") };
}
export function remoteConfigCalldata(fixture?: ReplacementFixture): string {
  const remote = solanaRemote(fixture);
  const rate = [1n, BigInt(remote.capacity), BigInt(remote.rate)];
  return "0xe8a1da17" + [64n, 96n, 0n, 1n, 32n, BigInt(remote.selector), 288n, 416n,
    ...rate, ...rate, 1n, 32n, 32n].map(word).join("") + remote.pool.slice(2) +
    word(32n) + remote.token.slice(2);
}
export function nextRemoteConfigStep(snapshot: RemoteSnapshot, target: RegistrationTarget): "complete" | "configure" {
  const remote = solanaRemote(target.fixture);
  if (nextRegistrationStep(snapshot.registration, target).kind !== "complete") {
    throw new Error("Finalized token registration required");
  }
  if (typeof snapshot.supported !== "boolean") { throw new Error("Invalid chain support evidence"); }
  const rateMatches = (rate: RemoteRate): boolean => rate.enabled === true &&
    rate.capacity === remote.capacity && rate.rate === remote.rate;
  if (snapshot.supported) {
    if (snapshot.pools.length !== 1 || snapshot.pools[0]?.toLowerCase() !== remote.pool ||
      snapshot.token.toLowerCase() !== remote.token || !rateMatches(snapshot.inbound) || !rateMatches(snapshot.outbound)) {
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
