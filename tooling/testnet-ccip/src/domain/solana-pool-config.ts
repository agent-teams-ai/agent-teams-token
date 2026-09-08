import { createHash } from "node:crypto";
import { BURNMINT_PROGRAM } from "./solana-pool-init.ts";
import { ROUTER_PROGRAM } from "./solana-registration.ts";
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from "./solana-mint.ts";
import type { MintInstruction, SolanaMintIntent } from "./solana-mint.ts";
import type { SolanaPoolInitExpectation } from "./solana-pool-init.ts";
export const POOL_CONFIG_OPERATIONS = ["init-chain-remote-config", "append-remote-pool-addresses", "set-chain-rate-limit", "create-lookup-table", "set-pool", "repair-remote-pool-encoding"] as const;
export const SEPOLIA_SELECTOR = "16015286601757825753";
export const REMOTE_TOKEN = "0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9";
export const REMOTE_POOL = "0x24508e2eb3bedc086318abc054153fd83823a4e2";
export const ALT_PROGRAM = "AddressLookupTab1e1111111111111111111111111";
export const FEE_QUOTER_PROGRAM = "FeeQPGkKDeRV1MgoYfMH6L8o3KeuYjwUZrgn4LRKfjHi";
export interface SolanaPoolConfigExpectation extends SolanaPoolInitExpectation {
  readonly operation: typeof POOL_CONFIG_OPERATIONS[number]; readonly chain: string;
  readonly signer: string; readonly ata: string; readonly registry: string; readonly routerConfig: string;
  readonly feeTokenConfig: string; readonly routerPoolSigner: string;
  readonly repairRateLimitsBase64?: string;
  readonly recentSlot: string | null; readonly alt: string | null; readonly altBump: number | null;
}
export interface SolanaPoolConfigEnvelope extends SolanaPoolConfigExpectation {
  readonly schema: "agtmai-solana-pool-config-v1"; readonly instructions: readonly MintInstruction[];
}
export const u64 = (n: string | bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const remoteBytes = (address: string): Buffer => Buffer.from(address.slice(2).padStart(64, "0"), "hex");
export const remotePoolBytes = (): Buffer => Buffer.from(REMOTE_POOL.slice(2), "hex");
const discriminator = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
const meta = (address: string, isSigner = false, isWritable = false) => ({ address, isSigner, isWritable });
export function altAddresses(e: SolanaPoolConfigExpectation): string[] {
  if (!e.alt) { throw new Error("ALT identity required"); }
  return [e.alt, e.registry, BURNMINT_PROGRAM, e.pool, e.ata, e.signer, SPL_TOKEN_PROGRAM, e.mint, e.feeTokenConfig, e.routerPoolSigner];
}
function validateRepair(e: SolanaPoolConfigExpectation): void {
  if (e.operation === "repair-remote-pool-encoding") {
    const rates = Buffer.from(e.repairRateLimitsBase64 ?? "", "base64");
    if (rates.length !== 66 || rates.toString("base64") !== e.repairRateLimitsBase64) { throw new Error("Exact persisted repair rate-limit bytes required"); }
    for (const offset of [0, 33]) {
      if (rates[offset + 16] !== 1 || rates.readBigUInt64LE(offset + 17) !== 10_000_000_000n ||
        rates.readBigUInt64LE(offset + 25) !== 1_000_000_000n || rates.readBigUInt64LE(offset) > 10_000_000_000n) { throw new Error("Wrong repair rate limits"); }
    }
  } else if (e.repairRateLimitsBase64 !== undefined) { throw new Error("Unexpected repair rate limits"); }
}
function validate(e: SolanaPoolConfigExpectation): void {
  if (e.testOnly !== true || e.cluster !== "solana-devnet" || !POOL_CONFIG_OPERATIONS.includes(e.operation)) { throw new Error("Invalid test-only pool config scope"); }
  validateRepair(e);
  const keys = [e.payer, e.mint, e.pool, e.chain, e.signer, e.ata, e.registry, e.routerConfig, e.feeTokenConfig, e.routerPoolSigner,
    SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, BURNMINT_PROGRAM, ROUTER_PROGRAM, ALT_PROGRAM, FEE_QUOTER_PROGRAM];
  keys.forEach(solanaPublicKeyBytes);
  if (new Set(keys).size !== keys.length) { throw new Error("Conflicting pool config addresses"); }
  if (e.operation === "create-lookup-table" || e.operation === "set-pool" || e.operation === "repair-remote-pool-encoding") {
    if (typeof e.recentSlot !== "string" || !/^[1-9][0-9]*$/.test(e.recentSlot) || BigInt(e.recentSlot) > BigInt(Number.MAX_SAFE_INTEGER) ||
      typeof e.alt !== "string" || keys.includes(e.alt) || !Number.isInteger(e.altBump) || e.altBump! < 0 || e.altBump! > 255) { throw new Error("Invalid persisted ALT identity"); }
    solanaPublicKeyBytes(e.alt);
  } else if (e.recentSlot !== null || e.alt !== null || e.altBump !== null) { throw new Error("Unexpected ALT identity for remote config"); }
}
  const instruction = (programId: string, accounts: MintInstruction["accounts"], data: Buffer) => ({ programId, accounts, dataBase64: data.toString("base64") });
export function poolConfigInstructions(e: SolanaPoolConfigExpectation): MintInstruction[] {
  validate(e);

  if (e.operation === "create-lookup-table") {
    const accounts = [meta(e.alt!, false, true), meta(e.payer, true, true), meta(e.payer, true, true), meta(SYSTEM_PROGRAM)];
    return [instruction(ALT_PROGRAM, accounts, Buffer.concat([u32(0), u64(e.recentSlot!), Buffer.from([e.altBump!])])),
      instruction(ALT_PROGRAM, accounts, Buffer.concat([u32(2), u64(10n), ...altAddresses(e).map(solanaPublicKeyBytes)]))];
  }
  if (e.operation === "set-pool") {
    return [instruction(ROUTER_PROGRAM, [meta(e.routerConfig), meta(e.registry, false, true), meta(e.mint), meta(e.alt!), meta(e.payer, true, true)],
      Buffer.concat([discriminator("set_pool"), u32(3), Buffer.from([3, 4, 7])]))];
  }
  const prefix = [u64(SEPOLIA_SELECTOR), solanaPublicKeyBytes(e.mint)];
  const accounts = [meta(e.pool), meta(e.chain, false, true), meta(e.payer, true, true)];
  if (e.operation === "set-chain-rate-limit") {
    const rate = Buffer.concat([Buffer.from([1]), u64(10_000_000_000n), u64(1_000_000_000n)]);
    return [instruction(BURNMINT_PROGRAM, accounts, Buffer.concat([discriminator("set_chain_rate_limit"), ...prefix, rate, rate]))];
  }
  accounts.push(meta(SYSTEM_PROGRAM));
  const init = e.operation === "init-chain-remote-config";
  const repair = e.operation === "repair-remote-pool-encoding";
  const pools = Buffer.concat([u32(1), u32(20), remotePoolBytes()]);
  const data = repair ? Buffer.concat([pools, u32(32), remoteBytes(REMOTE_TOKEN), Buffer.from([9])]) : init ? Buffer.concat([u32(0), u32(32), remoteBytes(REMOTE_TOKEN), Buffer.from([9])]) :
    pools;
  return [instruction(BURNMINT_PROGRAM, accounts, Buffer.concat([discriminator(repair ? "edit_chain_remote_config" : init ? "init_chain_remote_config" : "append_remote_pool_addresses"), ...prefix, data]))];
}
export function verifySolanaPoolConfigIntent(intent: SolanaMintIntent, expected: SolanaPoolConfigExpectation): SolanaPoolConfigEnvelope {
  const instructions = poolConfigInstructions(expected);
  if (intent.feePayer !== expected.payer || intent.instructions.length !== instructions.length || intent.instructions.some((ix, i) => {
    const allowed = instructions[i];
    return ix.programId !== allowed.programId || ix.dataBase64 !== allowed.dataBase64 || ix.accounts.length !== allowed.accounts.length ||
      ix.accounts.some((a, j) => a.address !== allowed.accounts[j].address || a.isSigner !== allowed.accounts[j].isSigner || a.isWritable !== allowed.accounts[j].isWritable);
  })) { throw new Error("Invalid exact pool config instructions"); }
  return { schema: "agtmai-solana-pool-config-v1", ...expected, instructions };
}
