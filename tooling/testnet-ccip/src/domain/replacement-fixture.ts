import { createHash } from "node:crypto";
import { solanaPublicKeyBytes } from "./solana-mint.ts";

/** Public TESTNET identity only. The PDA is derived, not evidence of deployment. */
export const REPLACEMENT = Object.freeze({
  schema: "agtmai-testnet-replacement-v1", testOnly: true, chainId: "11155111", cluster: "solana-devnet",
  administrator: "0x1d7bfcf10cbd789da22460265352126356701eb3",
  payer: "BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8",
  recipient: "BoiQxGHPgVaqxPn2TjqzmoHPd5toyfxxZ4wW2M7P3gK8",
  mint: "4JvM13AvtMbq7Jyvs2id3wS4gMh2yjAhT4pJphJX48o1",
  solanaPool: "55PYzTuSbH7mWSQmCqdPfQLkzPHzMKHQ7xaJF8sWxXz5",
  decimals: 9, supply: "100000000000", amount: "1000000000",
  forwardSelector: "16423721717087811551", reverseSelector: "16015286601757825753",
} as const);
export interface ReplacementFixture {
  readonly schema: typeof REPLACEMENT.schema;
  readonly testOnly: true; readonly chainId: "11155111"; readonly cluster: "solana-devnet";
  readonly administrator: string; readonly payer: string; readonly recipient: string;
  readonly mint: string; readonly solanaPool: string; readonly token: string; readonly pool: string;
  readonly decimals: 9; readonly supply: string; readonly amount: string;
  readonly forwardSelector: string; readonly reverseSelector: string; readonly identity: string;
}
export interface FixtureSelection { readonly fixture?: unknown; readonly fixtureIdentity?: string }
function address(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error("Operator-supplied nonzero TESTNET deployment address required");
  }
  return value.toLowerCase();
}
/** Call only with public addresses selected through the operator's authenticated channel. */
export function replacementFixture(token: string, pool: string): Readonly<ReplacementFixture> {
  const t = address(token), p = address(pool);
  if (t === p || [t, p].some(a => [REPLACEMENT.administrator,
    "0xbee91ba3ca94dd7c639ee6c1b1c2fc1a1996cdc9", "0x24508e2eb3bedc086318abc054153fd83823a4e2",
    "0x0bf3de8c5d3e8a2b34d2beeb17abfcebaf363a59"].includes(a))) {
    throw new Error("Conflicting replacement deployment identity");
  }
  const canonical = { ...REPLACEMENT, token: t, pool: p };
  const identity = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
  return Object.freeze({ ...canonical, identity });
}
export function validateReplacementFixture(value: unknown): Readonly<ReplacementFixture> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Unknown replacement fixture"); }
  const record = value as Record<string, unknown>;
  const canonical = replacementFixture(record.token as string, record.pool as string);
  if (Object.keys(record).length !== Object.keys(canonical).length ||
    Object.entries(canonical).some(([key, expected]) => record[key] !== expected)) {
    throw new Error("Malformed or mutated replacement fixture identity");
  }
  solanaPublicKeyBytes(canonical.payer); solanaPublicKeyBytes(canonical.mint); solanaPublicKeyBytes(canonical.solanaPool);
  return canonical;
}
/** Absence alone selects historical defaults. Presence never falls back. */
export function selectedFixture(selection: FixtureSelection): Readonly<ReplacementFixture> | undefined {
  if (!Object.hasOwn(selection, "fixture")) {
    if (Object.hasOwn(selection, "fixtureIdentity")) { throw new Error("Missing selected fixture"); }
    return undefined;
  }
  const fixture = validateReplacementFixture(selection.fixture);
  if (selection.fixtureIdentity !== fixture.identity) { throw new Error("Authenticated operator fixture identity required"); }
  return fixture;
}
export function fixtureNamespace(fixture: ReplacementFixture): string {
  return "agtmai-replacement-" + validateReplacementFixture(fixture).identity;
}

export interface ForwardRoute {
  readonly token: string; readonly pool: string; readonly administrator: string; readonly router: string;
  readonly selector: bigint; readonly recipient: string; readonly amount: bigint;
}
export interface ReverseRoute {
  readonly payer: string; readonly mint: string; readonly recipient: string; readonly amount: bigint | string;
  readonly rmn: string; readonly nativeMint: string; readonly selector?: bigint | string;
}
