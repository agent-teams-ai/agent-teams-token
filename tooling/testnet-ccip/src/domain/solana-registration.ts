import { createHash } from "node:crypto";
import { SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, solanaPublicKeyBytes } from "./solana-mint.ts";
import type { SolanaMintIntent, MintInstruction } from "./solana-mint.ts";
import type { SolanaPoolInitExpectation } from "./solana-pool-init.ts";
export const ROUTER_PROGRAM = "Ccip842gzYHhvdDkSyi2YVCoAWPbYJoApMFzSxQroE9C";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const REGISTRATION_OPERATIONS = ["create-token-account", "owner-propose-administrator", "accept-admin-role", "transfer-mint-authority"] as const;
export type RegistrationOperation = typeof REGISTRATION_OPERATIONS[number];
export interface SolanaRegistrationExpectation extends SolanaPoolInitExpectation {
  readonly operation: RegistrationOperation; readonly signer: string; readonly ata: string;
  readonly registry: string; readonly routerConfig: string;
}
export interface SolanaRegistrationEnvelope extends SolanaRegistrationExpectation {
  readonly schema: "agtmai-solana-registration-v1"; readonly instructions: readonly MintInstruction[];
}
const account = (address: string, isSigner = false, isWritable = false) => ({ address, isSigner, isWritable });
const discriminator = (name: string) => createHash("sha256").update("global:" + name).digest().subarray(0, 8);
export function registrationInstruction(expected: SolanaRegistrationExpectation): MintInstruction {
  if (expected.testOnly !== true || expected.cluster !== "solana-devnet" || !REGISTRATION_OPERATIONS.includes(expected.operation)) {
    throw new Error("Invalid test-only registration expectation");
  }
  const unique = [expected.payer, expected.mint, expected.pool, expected.signer, expected.ata, expected.registry, expected.routerConfig,
    SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, ROUTER_PROGRAM, ASSOCIATED_TOKEN_PROGRAM];
  unique.forEach(solanaPublicKeyBytes);
  if (new Set(unique).size !== unique.length) { throw new Error("Conflicting registration addresses"); }
  let programId: string, data: Buffer, accounts: MintInstruction["accounts"];
  if (expected.operation === "create-token-account") {
    programId = ASSOCIATED_TOKEN_PROGRAM; data = Buffer.from([1]);
    accounts = [account(expected.payer, true, true), account(expected.ata, false, true), account(expected.signer),
      account(expected.mint), account(SYSTEM_PROGRAM), account(SPL_TOKEN_PROGRAM)];
  } else if (expected.operation === "transfer-mint-authority") {
    programId = SPL_TOKEN_PROGRAM;
    data = Buffer.concat([Buffer.from([6, 0, 1]), solanaPublicKeyBytes(expected.signer)]);
    // Payer privilege is promoted to writable in the compiled message.
    accounts = [account(expected.mint, false, true), account(expected.payer, true, true)];
  } else {
    programId = ROUTER_PROGRAM;
    const propose = expected.operation === "owner-propose-administrator";
    data = propose ? Buffer.concat([discriminator("owner_propose_administrator"), solanaPublicKeyBytes(expected.payer)]) :
      discriminator("accept_admin_role_token_admin_registry");
    accounts = [account(expected.routerConfig), account(expected.registry, false, true), account(expected.mint), account(expected.payer, true, true),
      ...(propose ? [account(SYSTEM_PROGRAM)] : [])];
  }
  return { programId, accounts, dataBase64: data.toString("base64") };
}
export function verifySolanaRegistrationIntent(intent: SolanaMintIntent, expected: SolanaRegistrationExpectation): SolanaRegistrationEnvelope {
  const allowed = registrationInstruction(expected);
  const ix = intent.instructions[0];
  if (intent.feePayer !== expected.payer || intent.instructions.length !== 1 || !ix || ix.programId !== allowed.programId ||
    ix.dataBase64 !== allowed.dataBase64 || ix.accounts.length !== allowed.accounts.length || ix.accounts.some((a, i) =>
      a.address !== allowed.accounts[i]?.address || a.isSigner !== allowed.accounts[i]?.isSigner || a.isWritable !== allowed.accounts[i]?.isWritable)) {
    throw new Error("Invalid Solana registration instruction");
  }
  return { schema: "agtmai-solana-registration-v1", testOnly: true, cluster: expected.cluster, operation: expected.operation,
    payer: expected.payer, mint: expected.mint, pool: expected.pool, signer: expected.signer, ata: expected.ata,
    registry: expected.registry, routerConfig: expected.routerConfig, instructions: [structuredClone(allowed)] };
}
