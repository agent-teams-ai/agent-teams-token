import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AnalysisInput, GateManifest } from "../src/domain/model.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";

export async function writeCanonicalFixture(
  directory: string,
  manifest: GateManifest,
  input: AnalysisInput,
): Promise<{ readonly config: string; readonly policy: string; readonly triage: string; readonly manifest: GateManifest }> {
  await mkdir(directory, { recursive: true });
  const detectors = `${JSON.stringify({ schemaVersion: 1, slitherVersion: "0.11.6", detectors: input.detectorInventory }, null, 2)}\n`;
  const config = `${JSON.stringify({ exclude_dependencies: false, legacy_ast: false }, null, 2)}\n`;
  const policy = `${JSON.stringify({ schemaVersion: 1, suppressions: [] }, null, 2)}\n`;
  const triage = `${JSON.stringify({ schemaVersion: 1, findings: input.findings.map(({ fingerprint }) => ({ schemaVersion: 1, fingerprint, owner: "fixture-security", disposition: "accepted-design", rationale: "Independently reviewed golden evidence fixture finding.", reviewedAt: "2026-08-29T00:00:00.000Z" })) }, null, 2)}\n`;
  const accepted = { ...manifest, detectorInventory: { path: "detector-inventory.v1.json", sha256: sha256(detectors) } };
  await Promise.all([
    writeFile(join(directory, "production-closure.v1.json"), `${JSON.stringify(accepted, null, 2)}\n`),
    writeFile(join(directory, "detector-inventory.v1.json"), detectors),
    writeFile(join(directory, "slither.config.json"), config),
    writeFile(join(directory, "suppressions.v1.json"), policy),
    writeFile(join(directory, "triage.v1.json"), triage),
  ]);
  return { config: sha256(config), policy: sha256(policy), triage: sha256(triage), manifest: accepted };
}

export const schemaDirectory = "tooling/security/slither";
