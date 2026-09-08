import { SYSTEM_PROGRAM } from "./solana-mint.ts";
import type { SolanaMintIntent } from "./solana-mint.ts";
export const BURNMINT_PROGRAM = "41FGToCmdaWa1dgZLKFAjvmx6e6AjVTX7SVRibvsMGVB";
export const BURNMINT_PROGRAM_DATA = "4sVSCJqG9ZKEvnpN38qTzb7Kc8QdHakBgB87HN3FYRaz";
export const POOL_GLOBAL = "E4Bsi43kX3iwXAFia2ebm1mS5Xkmmdv3minZDnfo7Zzf";
export interface SolanaPoolInitExpectation {
  readonly testOnly: true; readonly cluster: "solana-devnet";
  readonly payer: string; readonly mint: string; readonly pool: string;
}
export interface SolanaPoolInitEnvelope extends SolanaPoolInitExpectation {
  readonly schema: "agtmai-solana-pool-init-v1";
  readonly instructions: SolanaMintIntent["instructions"];
}
const fail = (): never => { throw new Error("Invalid test-only Solana pool initialization"); };
export function verifySolanaPoolInitIntent(intent: SolanaMintIntent, expected: SolanaPoolInitExpectation): SolanaPoolInitEnvelope {
  const addresses = [expected.pool, expected.mint, expected.payer, SYSTEM_PROGRAM,
    BURNMINT_PROGRAM, BURNMINT_PROGRAM_DATA, POOL_GLOBAL];
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet" ||
    new Set(addresses).size !== 7 || addresses.some(a => !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) ||
    intent.feePayer !== expected.payer || intent.instructions.length !== 1) { return fail(); }
  const ix = intent.instructions[0];
  if (!ix || ix.programId !== BURNMINT_PROGRAM || ix.dataBase64 !== Buffer.from("afaf6d1f0d989bed", "hex").toString("base64") ||
    ix.accounts.length !== 7 || ix.accounts.some((a, i) => a.address !== addresses[i] ||
      a.isSigner !== (i === 2) || a.isWritable !== (i === 0 || i === 2))) { return fail(); }
  return { schema: "agtmai-solana-pool-init-v1", testOnly: true, cluster: expected.cluster,
    payer: expected.payer, mint: expected.mint, pool: expected.pool, instructions: structuredClone(intent.instructions) };
}
