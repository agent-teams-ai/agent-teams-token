import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runUnsignedPlanner } from "../../tooling/deployment-plan/src/composition/index.ts";

interface Arguments {
  readonly rpcUrl: string;
  readonly buildInfoPath: string;
  readonly artifactPath: string;
  readonly abiPath: string;
  readonly fixturePath: string;
  readonly trustRootsPath: string;
  readonly outputParent?: string;
  readonly bundleName: string;
  readonly nowSeconds: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
}

const knownFlags = new Set([
  "--rpc-url",
  "--build-info",
  "--artifact",
  "--abi",
  "--fixture",
  "--trust-roots",
  "--output",
  "--bundle",
  "--now",
  "--priority-fee",
  "--max-fee",
]);

export async function main(rawArguments = process.argv.slice(2)): Promise<void> {
  const parsed = parseArguments(rawArguments[0] === "--"
    ? rawArguments.slice(1)
    : rawArguments);
  const outputParent = parsed.outputParent === undefined
    ? await realpath(await mkdtemp(join(tmpdir(), "agtmai-deployment-plan-")))
    : resolve(parsed.outputParent);
  const result = await runUnsignedPlanner({
    rpcUrl: parsed.rpcUrl,
    buildInfoPath: resolve(parsed.buildInfoPath),
    artifactPath: resolve(parsed.artifactPath),
    abiPath: resolve(parsed.abiPath),
    fixturePath: resolve(parsed.fixturePath),
    trustRootsPath: resolve(parsed.trustRootsPath),
    outputParent,
    bundleName: parsed.bundleName,
    nowSeconds: parsed.nowSeconds,
    maxPriorityFeePerGas: parsed.maxPriorityFeePerGas,
    maxFeePerGas: parsed.maxFeePerGas,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function parseArguments(arguments_: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (
      flag === undefined
      || value === undefined
      || !knownFlags.has(flag)
      || value.startsWith("--")
      || values.has(flag)
    ) {
      throw new Error(`invalid or duplicate deployment planner argument: ${flag ?? "<missing>"}`);
    }
    values.set(flag, value);
  }
  const buildInfoPath = required(values, "--build-info");
  const artifactPath = required(values, "--artifact");
  return {
    rpcUrl: values.get("--rpc-url") ?? "http://127.0.0.1:8545/",
    buildInfoPath,
    artifactPath,
    abiPath: values.get("--abi") ?? "contracts/evm/abi/AGTMAIToken.abi.json",
    fixturePath: values.get("--fixture")
      ?? "contracts/evm/evidence/shared-test-vector.json",
    trustRootsPath: values.get("--trust-roots")
      ?? "tooling/deployment-plan/trust-roots.v1.json",
    outputParent: values.get("--output"),
    bundleName: values.get("--bundle") ?? "estimate",
    nowSeconds: decimal(
      values.get("--now") ?? String(Math.floor(Date.now() / 1000)),
      "--now",
    ),
    maxPriorityFeePerGas: decimal(
      values.get("--priority-fee") ?? "1000000000",
      "--priority-fee",
    ),
    maxFeePerGas: decimal(values.get("--max-fee") ?? "3000000000", "--max-fee"),
  };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function decimal(value: string, flag: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(`${flag} must be a canonical decimal integer`);
  }
  return BigInt(value);
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
