import { verifyCustodyTransition, type CustodyTransition } from "../domain/custody.ts";
import { loadDeploymentManifest, readDeploymentFile, parseStrict } from "@agent-teams/supply/deployment-files";
export async function verifyCustodyProof(manifestPath: string, transition: CustodyTransition): Promise<never> {
  // Recompile the canonical configuration and authenticate artifacts, creation evidence and all manifest digests.
  const { manifest } = await loadDeploymentManifest(manifestPath);
  verifyCustodyTransition(manifest, transition);
  // V1 authenticates creation evidence only. It contains no custody operation,
  // native receipt or finality record to bind this separately supplied transition.
  throw new Error("CUSTODY_TRANSITION_PROVENANCE_UNPROVEN");
}

if (process.argv[1]?.endsWith("custody-verify.ts")) {
  const args = process.argv.slice(2), value = (name: string): string => { const i = args.indexOf(name); if (i < 0 || !args[i + 1]) { throw new Error("CUSTODY_VERIFY_ARGUMENTS"); } return args[i + 1]!; };
  try {
    const parsed = parseStrict(new TextDecoder().decode(await readDeploymentFile(value("--evidence"))));
    if (parsed.diagnostics.length) { throw new Error("CUSTODY_VERIFY_EVIDENCE_INVALID"); }
    await verifyCustodyProof(value("--manifest"), parsed.value as CustodyTransition);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "invalid", reason: error instanceof Error ? error.message : "CUSTODY_VERIFY_FAILURE", broadcastAllowed: false })}\n`);
    process.exitCode = 2;
  }
}
