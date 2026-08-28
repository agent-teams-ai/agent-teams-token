import { compileLocalSource, type CompilerPorts } from "../application/compiler.js";
import { parseLocalSource } from "../adapters/strict-source.js";
import type { Diagnostic, LocalGenesisManifest } from "../domain/model.js";

export interface LocalCompilationResult {
  readonly diagnostics: Diagnostic[];
  readonly manifest?: LocalGenesisManifest;
  readonly canonicalBytes?: Uint8Array;
}

/** Internal composition boundary: untrusted source text is parsed strictly before compilation. */
export function compileLocalText(text: string, ports: CompilerPorts): LocalCompilationResult {
  const parsed = parseLocalSource(text);
  if (!parsed.value) {
    return { diagnostics: parsed.diagnostics };
  }
  return compileLocalSource(parsed.value, ports);
}
