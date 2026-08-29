import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runFixture } from "../application/runner.ts";
import { SolanaCliAdapter } from "../adapters/cli.ts";
import { PrivateRunStore } from "../adapters/filesystem.ts";
import { LoopbackPortAllocator } from "../adapters/ports.ts";
import { NodeCommandAdapter, OwnedValidatorAdapter } from "../adapters/process.ts";
import { JsonRpcAdapter } from "../adapters/rpc.ts";
import { PinnedToolResolver } from "../adapters/toolchain.ts";
import { Ed25519AuthorityTransactionAdapter } from "../adapters/transaction.ts";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const repositoryRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
  const outputIndex = args.indexOf("--output");
  if (args.length !== 2 || outputIndex !== 0 || !args[1]?.startsWith("/")) { throw new Error("Usage: node tooling/local-solana/src/composition/index.ts --output /absolute/private/output-root"); }
  const outputRoot = resolve(args[1]);
  const uid = process.getuid?.() ?? 0;
  const runRoot = process.platform === "darwin" ? `/private/tmp/agtmai-local-solana-${uid}` : `/tmp/agtmai-local-solana-${uid}`;
  const command = new NodeCommandAdapter(); const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const result = await runFixture({
      tools: new PinnedToolResolver(repositoryRoot, command), command, validator: new OwnedValidatorAdapter(), rpc: new JsonRpcAdapter(),
      cli: new SolanaCliAdapter(command), store: new PrivateRunStore(runRoot, outputRoot), ports: new LoopbackPortAllocator(),
      authorityTransactions: new Ed25519AuthorityTransactionAdapter(),
    }, controller.signal);
    process.stdout.write(`${JSON.stringify({ status: "READY", ...result })}\n`);
  } finally { process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt); }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((cause: unknown) => { const message = cause instanceof Error ? cause.message : "unknown local Solana failure"; process.stderr.write(`${message}\n`); process.exitCode = 1; });
}
