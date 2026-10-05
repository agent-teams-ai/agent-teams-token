import { lstatSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fixtureNamespace, selectedFixture, validateReplacementFixture } from "../domain/replacement-fixture.ts";
import type { FixtureSelection, ReplacementFixture } from "../domain/replacement-fixture.ts";
export interface FixtureSettings extends FixtureSelection {
  readonly testOnly: boolean; readonly chainId?: string; readonly cluster?: string;
  readonly expected?: { readonly testOnly?: boolean; readonly cluster?: string; readonly payer?: string;
    readonly mint?: string; readonly pool?: string; readonly fixture?: unknown };
  readonly administrator?: string; readonly token?: string; readonly pool?: string; readonly recipient?: string;
}
function validateSettings(settings: FixtureSettings, fixture: ReplacementFixture): void {
  if (settings.testOnly !== true || settings.chainId !== undefined && settings.chainId !== fixture.chainId ||
    settings.cluster !== undefined && settings.cluster !== fixture.cluster) { throw new Error("Wrong replacement TESTNET chain"); }
  for (const key of ["administrator", "token", "pool", "recipient"] as const) {
    const actual = settings[key];
    if (actual !== undefined && (key === "recipient" ? actual !== fixture[key] : actual.toLowerCase() !== fixture[key])) {
      throw new Error("Wrong replacement " + key);
    }
  }
  if (settings.expected) {
    const e = settings.expected;
    if (e.testOnly !== true || e.cluster !== fixture.cluster || e.payer !== fixture.payer || e.mint !== fixture.mint ||
      e.pool !== undefined && e.pool !== fixture.solanaPool || e.fixture !== undefined &&
      validateReplacementFixture(e.fixture).identity !== fixture.identity) { throw new Error("Wrong replacement Solana authority/peer"); }
  }
}
function isSymlink(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { return false; } throw error; }
}
/** Run before loading a signer/provider, acquiring locks or creating journal files. */
export function bindFixture(settings: FixtureSettings, journals: readonly string[] = []): Readonly<ReplacementFixture> | undefined {
  const fixture = selectedFixture(settings);
  if (!fixture) {
    if (settings.expected && Object.hasOwn(settings.expected, "fixture")) { throw new Error("Unbound nested fixture"); }
    return undefined;
  }
  validateSettings(settings, fixture);
  const namespace = fixtureNamespace(fixture);
  for (const file of journals) {
    if (typeof file !== "string" || !resolve(file).split(sep).includes(namespace)) {
      throw new Error("Fresh replacement journal namespace required; legacy reuse refused");
    }
    // A lexical namespace must never alias an old journal through a symlink.
    for (let path = resolve(file); ; path = dirname(path)) {
      if (isSymlink(path)) { throw new Error("Replacement journal symlink refused"); }
      if (dirname(path) === path) { break; }
    }
  }
  return fixture;
}
