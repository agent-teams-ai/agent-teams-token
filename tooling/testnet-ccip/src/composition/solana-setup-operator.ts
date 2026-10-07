import { createSolanaMintOperatorAttempt } from "../adapters/solana-sdk.mjs";
import { createSolanaPoolInitOperatorAttempt } from "../adapters/solana-pool-init-sdk.mjs";
import { createSolanaRegistrationOperatorAttempt } from "../adapters/solana-registration-sdk.mjs";
import { createSolanaPoolConfigOperatorAttempt } from "../adapters/solana-pool-config-sdk.mjs";
import { capturePrepared, captureSigned, checkSetupSigned } from "../adapters/solana-setup-operator.ts";
import type { OperatorAttempt, OperatorSignPrepared, InspectedSetup } from "../adapters/solana-setup-operator.ts";
import type { UnsignedMintSdk } from "../adapters/solana-sdk.mjs";
import type { UnsignedPoolInitSdk } from "../adapters/solana-pool-init-sdk.mjs";
import type { UnsignedRegistrationSdk, RegistrationInput } from "../adapters/solana-registration-sdk.mjs";
import type { UnsignedPoolConfigSdk, ConfigInput } from "../adapters/solana-pool-config-sdk.mjs";
import type { TestKeys, PreparedTransaction, BlockValidity } from "../adapters/solana-transaction-sdk.mjs";
import type { SolanaMintExpectation } from "../domain/solana-mint.ts";
import type { SolanaPoolInitExpectation } from "../domain/solana-pool-init.ts";
import { REGISTRATION_OPERATIONS, type SolanaRegistrationExpectation } from "../domain/solana-registration.ts";
import { POOL_CONFIG_OPERATIONS, type SolanaPoolConfigExpectation } from "../domain/solana-pool-config.ts";
import { selectedFixture, validateReplacementFixture } from "../domain/replacement-fixture.ts";
import type { FixtureSettings } from "../adapters/fixture-binding.ts";
import { selectTestSdk, TEST_SDK_PROFILE, type TestSdkSelection, type ExplicitTestSdkSelection } from "../adapters/test-sdk-policy.ts";
import { createSdkTestFetch, DEFAULT_SOLANA_RPC, selectSolanaRpc, UndrainedTestRpcBody } from "../adapters/test-rpc.ts";

export interface SetupIO<E, S> {
  readonly fetcher: typeof fetch;
  readonly openSdk?: (directory: string, selection: ExplicitTestSdkSelection) => Promise<S>;
  readonly signPrepared?: OperatorSignPrepared<E>;
}
type Settings<E> = FixtureSettings & TestSdkSelection & { readonly expected: E; readonly providerDirectory: string; readonly testOnly: true };
export type MintSettings = Settings<SolanaMintExpectation> & { readonly journalFile: string };
export type InitSettings = Settings<SolanaPoolInitExpectation> & { readonly journalFile: string };
export type RegistrationSettings = Settings<RegistrationInput> & { readonly journalDirectory: string };
export type ConfigSettings = Settings<ConfigInput> & { readonly journalDirectory: string; readonly registrationJournalFile: string };
export interface MintResult { readonly status: "unresolved" | "succeeded" | "failed"; readonly reason: string; readonly signature: string }
export interface RegistrationResult extends MintResult {
  readonly operation: SolanaRegistrationExpectation["operation"];
  readonly phase: "signed" | "submitting" | "submitted" | "succeeded" | "failed";
}
export interface ConfigResult extends MintResult {
  readonly operation: SolanaPoolConfigExpectation["operation"]; readonly phase: RegistrationResult["phase"]; readonly alt: string | null;
}
export function setupObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) { throw new Error("Invalid TEST setup input"); }
  return value as Record<string, unknown>;
}
function reference(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) { throw new Error("Invalid TEST key reference"); }
  return value;
}
export function testKeys(value: unknown): TestKeys {
  const raw = setupObject(value);
  if (raw.testOnly !== true) { throw new Error("Test-only operator keys required"); }
  return Object.freeze({ testOnly: true, payerFile: reference(raw.payerFile) });
}
export function mintTestKeys(value: unknown): TestKeys & { mintFile: string } {
  return Object.freeze({ ...testKeys(value), mintFile: reference(setupObject(value).mintFile) });
}
/** Inert initializer: capture references and one private attempt, never read custody or open admission here. */
function operatorIO<E, S, K>(keys: K, fetcher: typeof fetch,
  open: (directory: string, selection: ExplicitTestSdkSelection) => Promise<OperatorAttempt<E, S, K>>): SetupIO<E, S> {
  if (typeof fetcher !== "function") { throw new Error("Explicit TEST operator fetch required"); }
  let attempt: OperatorAttempt<E, S, K> | undefined, opening = false;
  return Object.freeze({ fetcher,
    async openSdk(directory: string, selection: ExplicitTestSdkSelection): Promise<S> {
      if (opening) { throw new Error("Operator IO already used"); }
      opening = true; attempt = await open(directory, selection); return attempt.sdk;
    },
    async signPrepared(prepared: Readonly<PreparedTransaction>, expected: Readonly<E>) {
      if (!attempt) { throw new Error("TEST setup operator attempt missing"); }
      return attempt.acquireSigner(keys)(prepared, expected);
    },
  });
}
export const createMintOperatorIO = (keys: TestKeys & { mintFile: string }, fetcher: typeof fetch): SetupIO<SolanaMintExpectation, UnsignedMintSdk> =>
  operatorIO(mintTestKeys(keys), fetcher, createSolanaMintOperatorAttempt);
export const createPoolInitOperatorIO = (keys: TestKeys, fetcher: typeof fetch): SetupIO<SolanaPoolInitExpectation, UnsignedPoolInitSdk> =>
  operatorIO(testKeys(keys), fetcher, createSolanaPoolInitOperatorAttempt);
export const createRegistrationOperatorIO = (keys: TestKeys, fetcher: typeof fetch): SetupIO<SolanaRegistrationExpectation, UnsignedRegistrationSdk> =>
  operatorIO(testKeys(keys), fetcher, createSolanaRegistrationOperatorAttempt);
export const createPoolConfigOperatorIO = (keys: TestKeys, fetcher: typeof fetch): SetupIO<SolanaPoolConfigExpectation, UnsignedPoolConfigSdk> =>
  operatorIO(testKeys(keys), fetcher, createSolanaPoolConfigOperatorAttempt);

/** Pure ingress. Own invalid profiles/functions cannot reach fixture path IO. */
export function selectSetup<E, S>(settings: FixtureSettings & TestSdkSelection & { readonly providerDirectory: string }, io?: SetupIO<E, S>): ExplicitTestSdkSelection | undefined {
  const fixture = selectedFixture(settings), selected = selectTestSdk(settings, settings.providerDirectory, fixture);
  if (!selected) { return undefined; }
  if (!io || typeof io.fetcher !== "function" ||
    Object.hasOwn(settings, "replayFetch") && settings.replayFetch !== io.fetcher ||
    Object.hasOwn(io, "openSdk") && typeof io.openSdk !== "function" ||
    Object.hasOwn(io, "signPrepared") && typeof io.signPrepared !== "function") { throw new Error("Explicit TEST setup IO required"); }
  return Object.freeze({ ...settings, providerProfile: TEST_SDK_PROFILE, testOnly: true, fixture: selected.fixture,
    fixtureIdentity: selected.fixture.identity, providerArchives: selected.archives, replayFetch: io.fetcher });
}
export function freezeSetupExpected<E extends object>(expected: E): Readonly<E> {
  const copy = structuredClone(expected);
  if ("fixture" in copy && copy.fixture && typeof copy.fixture === "object") { Object.freeze(copy.fixture); }
  return Object.freeze(copy);
}
const ingressDiagnostics = new Set([
  "Test-only Solana settings required", "Test-only registration settings required", "Explicit test-only pool configuration required",
  "Unknown or non-TEST SDK profile", "Canonical TEST SDK directory required",
  "TEST SDK requires exact selected fixture and retained archives", "Divergent or invalid TEST SDK root alias", "Explicit TEST setup IO required",
  "Missing selected fixture", "Unknown replacement fixture", "Operator-supplied nonzero TESTNET deployment address required",
  "Conflicting replacement deployment identity", "Malformed or mutated replacement fixture identity", "Authenticated operator fixture identity required",
  "Wrong replacement TESTNET chain", "Wrong replacement administrator", "Wrong replacement token", "Wrong replacement pool",
  "Wrong replacement recipient", "Wrong replacement Solana authority/peer", "Unbound nested fixture",
  "Fresh replacement journal namespace required; legacy reuse refused", "Replacement journal symlink refused",
]);
/** Cover synchronous ingress before any Host await; preserve only exact public diagnostics, never error objects. */
export function setupIngress<T>(work: () => T): T {
  let label: string;
  try { return work(); }
  catch (error) { label = error instanceof Error && ingressDiagnostics.has(error.message) ? error.message : "TEST setup failed"; }
  throw new Error(label);
}
export function latestSetupBlock(value: unknown): Readonly<BlockValidity> {
  const latest = setupObject(setupObject(value).value);
  if (typeof latest.blockhash !== "string" || typeof latest.lastValidBlockHeight !== "number" ||
    !Number.isSafeInteger(latest.lastValidBlockHeight) || latest.lastValidBlockHeight <= 0) { throw new Error("Invalid setup block validity"); }
  return Object.freeze({ blockhash: latest.blockhash, lastValidBlockHeight: String(latest.lastValidBlockHeight) });
}
class OperatorRequired extends Error {
  constructor() { super("TEST setup operator signer required for new operation"); }
}
export async function signSetup<E, R>(prepared: PreparedTransaction, expected: E, latest: Readonly<BlockValidity>,
  inspect: (bytes: string, expected: E) => InspectedSetup<R>, signPrepared?: OperatorSignPrepared<E>) {
  const captured = capturePrepared(prepared);
  if (captured.blockhash !== latest.blockhash || captured.lastValidBlockHeight !== latest.lastValidBlockHeight) { throw new Error("Prepared setup validity mismatch"); }
  if (!signPrepared) { throw new OperatorRequired(); }
  const signed = captureSigned(await signPrepared(captured, expected));
  // The callback cannot replace the comparison strings or supply trusted inspection metadata.
  return checkSetupSigned(captured, signed, inspect(signed.bytesBase64, expected));
}

/** Lexical setup owner. Failed body reads/cancels retain guards until dedicated-process termination. */
export function setupLifetime(fetcher: typeof fetch, drainMs = 20_000) {
  const abort = new AbortController(), pending = new Set<Promise<unknown>>();
  let closing = false, physicalDebt = false, closePromise: Promise<void> | undefined;
  const assertOpen = (): void => { if (closing) { throw new Error("TEST setup attempt closing"); } };
  const track = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing) { return Promise.reject(new Error("TEST setup attempt closing")); }
    const result = Promise.resolve().then(() => { assertOpen(); return work(); }); pending.add(result);
    void result.then(() => pending.delete(result), error => {
      // Signing and acquisition can reject with body debt without using ownedFetch.
      // Latch it before logical removal or the caller's fixed-label redaction.
      if (error instanceof UndrainedTestRpcBody) { physicalDebt = true; }
      pending.delete(result);
    });
    let timer: ReturnType<typeof setTimeout>;
    // A timed-out observer does not release its outstanding body/sign work or admission guards.
    return Promise.race([result, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Unresolved TEST setup operation")), 20_000);
    })]).finally(() => clearTimeout(timer));
  };
  const checked = createSdkTestFetch(DEFAULT_SOLANA_RPC, fetcher);
  const ownedFetch: typeof fetch = (input, init) => track(() => checked(input, { ...init,
    signal: init?.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal }));
  const close = (destroy: () => Promise<void>): Promise<void> => {
    if (closePromise) { return closePromise; }
    closing = true; abort.abort();
    const drain = (async () => {
      await Promise.allSettled(pending);
      // Logical rejection cannot acknowledge an acquired body's physical producer/cancellation.
      if (physicalDebt) { throw new Error("Unresolved TEST setup cleanup debt"); }
      await destroy();
    })();
    let timer: ReturnType<typeof setTimeout>;
    closePromise = Promise.race([drain, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Unresolved TEST setup cleanup debt")), drainMs);
    })]).finally(() => clearTimeout(timer)); return closePromise;
  };
  async function run<T>(destroy: () => Promise<void>, work: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; label: string };
    try { outcome = { ok: true, value: await track(work) }; }
    catch (error) { outcome = { ok: false, label: error instanceof OperatorRequired ? "TEST setup operator signer required for new operation" : "TEST setup failed" }; }
    try { await close(destroy); } catch {
      throw new Error(outcome.ok ? "TEST setup unresolved cleanup debt" : outcome.label + "; unresolved cleanup debt");
    }
    if (!outcome.ok) { throw new Error(outcome.label); }
    return outcome.value;
  }
  return { fetcher: ownedFetch, track, close, run, assertOpen };
}

function cliSelection(raw: Record<string, unknown>) {
  return {
    ...(Object.hasOwn(raw, "providerProfile") ? { providerProfile: raw.providerProfile } : {}),
    ...(Object.hasOwn(raw, "fixture") ? { fixture: raw.fixture } : {}),
    ...(Object.hasOwn(raw, "fixtureIdentity") ? { fixtureIdentity: reference(raw.fixtureIdentity) } : {}),
    ...(Object.hasOwn(raw, "providerArchives") ? { providerArchives: reference(raw.providerArchives) } : {}),
    ...(Object.hasOwn(raw, "ccipProviderDirectory") ? { ccipProviderDirectory: reference(raw.ccipProviderDirectory) } : {}),
    ...(Object.hasOwn(raw, "sdkDirectory") ? { sdkDirectory: reference(raw.sdkDirectory) } : {}),
    ...(Object.hasOwn(raw, "chainId") ? { chainId: reference(raw.chainId) } : {}),
    ...(Object.hasOwn(raw, "cluster") ? { cluster: reference(raw.cluster) } : {}),
    ...(Object.hasOwn(raw, "administrator") ? { administrator: reference(raw.administrator) } : {}),
    ...(Object.hasOwn(raw, "token") ? { token: reference(raw.token) } : {}),
    ...(Object.hasOwn(raw, "pool") ? { pool: reference(raw.pool) } : {}),
    ...(Object.hasOwn(raw, "recipient") ? { recipient: raw.recipient } : {})
  };
}

/** JSON is untrusted input; functions are statically selected by the CLI, never deserialized. */
export function parseSetupCli(value: unknown, kind: "mint"): MintSettings;
export function parseSetupCli(value: unknown, kind: "init"): InitSettings;
export function parseSetupCli(value: unknown, kind: "registration"): RegistrationSettings;
export function parseSetupCli(value: unknown, kind: "config"): ConfigSettings;
export function parseSetupCli(value: unknown, kind: "mint" | "init" | "registration" | "config"): MintSettings | InitSettings | RegistrationSettings | ConfigSettings {
  const raw = setupObject(value), e = setupObject(raw.expected);
  if (raw.testOnly !== true || e.testOnly !== true || e.cluster !== "solana-devnet") { throw new Error("Test-only setup settings required"); }
  const base = { testOnly: true, expected: { testOnly: true, cluster: "solana-devnet", payer: reference(e.payer), mint: reference(e.mint),
      ...(Object.hasOwn(e, "fixture") ? { fixture: validateReplacementFixture(e.fixture) } : {}) },
    providerDirectory: reference(raw.providerDirectory),
    ...cliSelection(raw) } as const;
  if (Object.hasOwn(raw, "replayFetch")) { throw new Error("JSON cannot select a fetch function"); }
  if (kind === "mint") { return { ...base, expected: { ...base.expected, rentLamports: reference(e.rentLamports) }, journalFile: reference(raw.journalFile) }; }
  const pool = { ...base.expected, pool: reference(e.pool) };
  if (kind === "init") { return { ...base, expected: pool, journalFile: reference(raw.journalFile) }; }
  const journalDirectory = reference(raw.journalDirectory);
  if (kind === "registration") {
    const operation = REGISTRATION_OPERATIONS.find(op => op === e.operation);
    if (!operation) { throw new Error("Invalid registration operation"); }
    return { ...base, expected: { ...pool, operation }, journalDirectory };
  }
  const operation = POOL_CONFIG_OPERATIONS.find(op => op === e.operation);
  if (!operation) { throw new Error("Invalid configuration operation"); }
  if (e.recentSlot !== undefined && e.recentSlot !== null && typeof e.recentSlot !== "string") { throw new Error("Invalid ALT slot"); }
  return { ...base, expected: { ...pool, operation, ...(e.recentSlot !== undefined ? { recentSlot: e.recentSlot } : {}),
    ...(e.repairRateLimitsBase64 !== undefined ? { repairRateLimitsBase64: reference(e.repairRateLimitsBase64) } : {}) },
    journalDirectory, registrationJournalFile: reference(raw.registrationJournalFile) };
}
export function operatorTestFetch(value: unknown): typeof fetch {
  const raw = setupObject(value);
  if (!Object.hasOwn(raw, "solanaRpc") || typeof raw.solanaRpc !== "string") { throw new Error("Explicit operator Devnet transport choice required"); }
  return createSdkTestFetch(selectSolanaRpc({ solanaRpc: raw.solanaRpc }), globalThis.fetch);
}
