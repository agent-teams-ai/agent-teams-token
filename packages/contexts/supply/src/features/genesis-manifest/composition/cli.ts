#!/usr/bin/env node
import { resolve } from "node:path";
import { inspectArtifacts, readSafeSource, writeArtifact } from "../adapters/artifact-store.js";
import { encodeAllocationCommitment } from "../adapters/abi.js";
import { sha256 } from "../adapters/digest.js";
import { parseProposal } from "../adapters/strict-source.js";
import type { Diagnostic } from "../domain/model.js";
import { compileLocalText } from "./compile-local.js";

export const EXIT = Object.freeze({ success: 0, validation: 2, io: 3, internal: 4 });
async function main(arguments_: readonly string[]): Promise<number> {
  const [command, first, second] = arguments_;
  try {
    if (command === "validate-proposal" && first) {
      const parsed = parseProposal(await readSafeSource(first, `${first}.proposal-validation-output-disabled`)); if (parsed.diagnostics.length) {return report(parsed.diagnostics);}
      process.stdout.write(`${JSON.stringify({ valid: true, purpose: "proposal", deployable: false })}\n`); return EXIT.success;
    }
    if (command === "compile-local" && first && second) {
      const text = await readSafeSource(first, second);
      const compiled = compileLocalText(text, { encodeAllocationCommitment, sha256 }); if (!compiled.manifest || !compiled.canonicalBytes) {return report(compiled.diagnostics);}
      const directory = await writeArtifact(second, compiled.manifest, compiled.canonicalBytes);
      process.stdout.write(`${JSON.stringify({ directory: resolve(directory), sourceSha256: compiled.manifest.sourceSha256, localFixtureArtifactSha256: compiled.manifest.localFixtureArtifactSha256, genesisAllocationHash: compiled.manifest.genesisAllocationHash })}\n`); return EXIT.success;
    }
    if (command === "inspect-local" && first) {
      process.stdout.write(`${JSON.stringify(await inspectArtifacts(first))}\n`); return EXIT.success;
    }
    process.stderr.write("usage: cli validate-proposal SOURCE | compile-local SOURCE OUTPUT_ROOT | inspect-local OUTPUT_ROOT\n"); return EXIT.validation;
  } catch (cause) {
    const error = cause as NodeJS.ErrnoException;
    const isIo = typeof error.code === "string" || (error instanceof Error && error.message.startsWith("GENESIS_IO_"));
    process.stderr.write(`${JSON.stringify({ code: isIo ? "GENESIS_IO_FAILURE" : "GENESIS_INTERNAL_FAILURE", message: error instanceof Error ? error.message : "unknown failure" })}\n`);
    return isIo ? EXIT.io : EXIT.internal;
  }
}
function report(diagnostics: readonly Diagnostic[]): number { process.stderr.write(`${JSON.stringify({ diagnostics })}\n`); return EXIT.validation; }
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {process.exitCode = await main(process.argv.slice(2));}
