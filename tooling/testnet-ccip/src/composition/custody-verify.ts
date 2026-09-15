import { verifyCustodyTransition, type CustodyTransition, type CustodyTransitionResult } from "../domain/custody.ts";
import type { DeploymentManifest } from "@agent-teams/supply/deployment";
import { readFile } from "node:fs/promises";
export function verifyCustodyProof(manifest: DeploymentManifest, transition: CustodyTransition): CustodyTransitionResult { return verifyCustodyTransition(manifest, transition); }

if (process.argv[1]?.endsWith("custody-verify.ts")) {
  const args = process.argv.slice(2), value = (name: string): string => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) { throw new Error("CUSTODY_VERIFY_ARGUMENTS"); } return args[i + 1]!; };
  try {
    const manifest = JSON.parse(await readFile(value("--manifest"), "utf8")) as DeploymentManifest;
    const transition = JSON.parse(await readFile(value("--evidence"), "utf8")) as CustodyTransition;
    const result = verifyCustodyProof(manifest, transition);
    process.stdout.write(`${JSON.stringify({ status: "verified", broadcastAllowed: false, result })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "invalid", reason: error instanceof Error ? error.message : "CUSTODY_VERIFY_FAILURE", broadcastAllowed: false })}\n`);
    process.exitCode = 2;
  }
}
