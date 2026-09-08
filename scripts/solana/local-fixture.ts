import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../tooling/local-solana/src/composition/index.ts";

const rawArguments = process.argv.slice(2);
const argumentsFromCli = rawArguments[0] === "--" ? rawArguments.slice(1) : rawArguments;
const argumentsForFixture = argumentsFromCli.length === 0
  ? ["--output", join(tmpdir(), "agtmai-solana-evidence")]
  : argumentsFromCli;

await main(argumentsForFixture);
