#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { assessReadiness, assertReadinessBundle } from "../application/readiness.ts";
import { digestReadinessManifest, parseReadinessEvidence, parseReadinessManifestProtocol } from "../adapters/readiness-evidence.ts";
import { parseJsonWithoutDuplicates } from "../adapters/strict-json.ts";

const option = (args: readonly string[], name: string): string => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) { throw new Error("READINESS_ARGUMENTS"); }
  return args[i + 1]!;
};
export async function readinessCli(args: readonly string[]): Promise<number> {
  try {
    const command = args[0];
    if (command === "evaluate") {
      const manifest = parseJsonWithoutDuplicates(await readFile(option(args, "--manifest"))) as Record<string, unknown>;
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) { throw new Error("READINESS_MANIFEST_INVALID"); }
      const protocol = parseReadinessManifestProtocol(manifest);
      const evidence = parseReadinessEvidence(new TextEncoder().encode(await readFile(option(args, "--evidence"), "utf8")));
      const expectedDigest = digestReadinessManifest(manifest);
      if (args.includes("--manifest-sha256") && option(args, "--manifest-sha256") !== expectedDigest) { throw new Error("READINESS_MANIFEST_MISMATCH"); }
      if (evidence.manifestSha256 !== expectedDigest) { throw new Error("READINESS_MANIFEST_MISMATCH"); }
      const report = assessReadiness(evidence, protocol);
      await writeFile(option(args, "--output"), `${JSON.stringify(report)}\n`, { flag: "wx" });
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return report.status === "qualified" ? 0 : 2;
    }
    if (command === "verify") {
      const bundle = parseJsonWithoutDuplicates(await readFile(option(args, "--bundle"))) as Record<string, unknown>;
      assertReadinessBundle(bundle, option(args, "--manifest-sha256"));
      if (args.includes("--now")) {
        const now = option(args, "--now");
        if (!/^(0|[1-9][0-9]*)$/u.test(now) || BigInt(now) < BigInt(String(bundle.observedAt)) || BigInt(now) > BigInt(String(bundle.validUntil))) { throw new Error("READINESS_BUNDLE_STALE"); }
      }
      process.stdout.write(`${JSON.stringify({ status: "verified", broadcastAllowed: false })}\n`);
      return 0;
    }
    if (command === "observe") { throw new Error("READINESS_OBSERVATION_REQUIRES_CONFIGURED_READ_ONLY_PROVIDER"); }
    throw new Error("READINESS_ARGUMENTS");
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "invalid", reason: error instanceof Error ? error.message : "READINESS_FAILURE", broadcastAllowed: false })}\n`);
    return 2;
  }
}
if (process.argv[1]?.endsWith("readiness.ts")) { process.exitCode = await readinessCli(process.argv.slice(2)); }
