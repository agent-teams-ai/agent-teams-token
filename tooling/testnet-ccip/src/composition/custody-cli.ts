#!/usr/bin/env node
import { custodyCommand } from "./custody.ts";
import type { CustodyRunPorts, CustodyRunResult } from "../application/custody-run.ts";

export type CustodyMode = "prepare" | "next" | "reconcile" | "status";
export interface CustodyCliPorts { readonly create: (settingsPath: string) => Promise<CustodyRunPorts>; }

/** Composition boundary for an operator-provided, test-only RPC/signer adapter. */
export async function runCustodyCli(args: readonly string[], ports?: CustodyCliPorts): Promise<CustodyRunResult> {
  const mode = args[0] as CustodyMode, index = args.indexOf("--settings"), settingsPath = index >= 0 ? args[index + 1] : undefined;
  const modes: readonly CustodyMode[] = ["prepare", "next", "reconcile", "status"];
  if (!modes.includes(mode) || !settingsPath) { throw new Error("CUSTODY_ARGUMENTS"); }
  if (!ports) { throw new Error("CUSTODY_PORTS_REQUIRED"); }
  return custodyCommand(mode, settingsPath, await ports.create(settingsPath));
}

if (process.argv[1]?.endsWith("custody-cli.ts")) {
  try {
    // No default port factory exists: an operator must inject the reviewed
    // test-only adapter boundary from its private runtime configuration.
    const result = await runCustodyCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const unavailable = error instanceof Error && error.message === "CUSTODY_PORTS_REQUIRED";
    process.stderr.write(`${JSON.stringify({ status: unavailable ? "unavailable" : "invalid", reason: error instanceof Error ? error.message : "CUSTODY_FAILURE", broadcastAllowed: false })}\n`);
    process.exitCode = unavailable ? 3 : 2;
  }
}
