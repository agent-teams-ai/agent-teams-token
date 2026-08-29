import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture } from "../application/runner.ts";
import { SolanaCliAdapter } from "../adapters/cli.ts";
import { PrivateRunStore } from "../adapters/filesystem.ts";
import { LoopbackPortAllocator } from "../adapters/ports.ts";
import { NodeCommandAdapter, OwnedValidatorAdapter } from "../adapters/process.ts";
import { JsonRpcAdapter } from "../adapters/rpc.ts";
import { PinnedToolResolver } from "../adapters/toolchain.ts";
import { Ed25519AuthorityTransactionAdapter } from "../adapters/transaction.ts";

type PublicDiagnostic = "SOLANA_CLI_USAGE" | "SOLANA_FIXTURE_FAILED";

class CliUsageError extends Error {}

interface CliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly exitCode: (value: number) => void;
}

type FixtureExecution = (args: readonly string[]) => Promise<{ readonly jsonPath: string; readonly markdownPath: string }>;

async function executeFixture(args: readonly string[]) {
  const repositoryRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  const outputIndex = args.indexOf("--output");
  if (args.length !== 2 || outputIndex !== 0 || !args[1]?.startsWith("/")) { throw new CliUsageError(); }
  const outputRoot = resolve(args[1]);
  const uid = process.getuid?.() ?? 0;
  const runRoot = process.platform === "darwin" ? `/private/tmp/agtmai-local-solana-${uid}` : `/tmp/agtmai-local-solana-${uid}`;
  const command = new NodeCommandAdapter(); const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    return await runFixture({
      tools: new PinnedToolResolver(repositoryRoot, command), command, validator: new OwnedValidatorAdapter(), rpc: new JsonRpcAdapter(),
      cli: new SolanaCliAdapter(command), store: new PrivateRunStore(runRoot, outputRoot), ports: new LoopbackPortAllocator(),
      authorityTransactions: new Ed25519AuthorityTransactionAdapter(),
      environment: process.env,
    }, controller.signal);
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

/** The sole supported process boundary: every result and failure is sanitized here. */
export async function runCliBoundary(args: readonly string[], execute: FixtureExecution = executeFixture, io: CliIo = processIo()): Promise<number> {
  try {
    const result = await execute(args);
    const bundleId = basename(dirname(result.jsonPath));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(bundleId) || bundleId === "." || bundleId === "..") { throw new Error("invalid bundle identity"); }
    io.stdout(`${JSON.stringify({ status: "READY", bundleId })}\n`);
    return 0;
  } catch (cause) {
    const diagnosticCode: PublicDiagnostic = cause instanceof CliUsageError ? "SOLANA_CLI_USAGE" : "SOLANA_FIXTURE_FAILED";
    try { io.stderr(`${JSON.stringify({ status: "FAILED", diagnosticCode })}\n`); } catch {}
    try { io.exitCode(1); } catch {}
    return 1;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  return await runCliBoundary(args);
}

function processIo(): CliIo {
  return {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    exitCode: (value) => { process.exitCode = value; },
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
