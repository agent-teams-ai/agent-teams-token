import {readFile} from "node:fs/promises";
import {stripTypeScriptTypes} from "node:module";
import {fileURLToPath} from "node:url";
import {compileFunction} from "node:vm";
import {cleanupFailures, finishWithCleanup} from "../../../local-evm/cleanup.ts";
import {removeOwnedRunDirectory} from "../../../local-evm/run-lease.ts";
import {runStartupCustodyOwner, type Finalizer} from "../../../local-evm/tests/fixtures/startup-custody.ts";

// Evaluate the proof's actual private finally block; no production hook.
// This source and the fixture are both removed by deployment-plan rollback.
export async function loadProofFinalizer(): Promise<Finalizer> {
  const source = await readFile(new URL("../../../../scripts/deployment/local-execution-proof.ts", import.meta.url), "utf8");
  const body = `async function finalizeLocalRun({primary, anvil, runDirectory}) {${source.slice(source.lastIndexOf("  finally {", source.indexOf("/* oxlint-enable complexity */")), source.indexOf("/* oxlint-enable complexity */")).replace(/^  finally \{/u, "").replace(/\}\s*\}\s*$/u, "")}}`;
  return compileFunction(`${stripTypeScriptTypes(body)}\nreturn finalizeLocalRun;`,
    ["process", "finishWithCleanup", "cleanupFailures", "removeOwnedRunDirectory"])(process, finishWithCleanup, cleanupFailures, removeOwnedRunDirectory) as Finalizer;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {await runStartupCustodyOwner(loadProofFinalizer);}
