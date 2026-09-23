#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { loadPreparedProductionPackage, readDeploymentFile } from "@agent-teams/supply/deployment-files";
import { parseProductionJsonWithoutDuplicates } from "../adapters/strict-json.ts";
import { createContributorCommitmentIntent, type ContributorCapacityObservation, type ContributorCommitmentInput } from "./contributor-commitment-intent.ts";
import { canonicalJson } from "../domain/identity.ts";

export async function contributorCommitmentCli(args: readonly string[]): Promise<number> {
  try {
    const names = ["--prepared", "--input", "--observation", "--output"];
    if (args.length !== 8 || args.some((value, index) => index % 2 === 0 ? !names.includes(value) : !value)) {throw new Error("COMMIT_ARGUMENTS");}
    const opts = new Map<string, string>();
    for (let index = 0; index < args.length; index += 2) {if (opts.has(args[index]!)) {throw new Error("COMMIT_ARGUMENTS");} opts.set(args[index]!, args[index + 1]!);}
    if (opts.size !== 4) {throw new Error("COMMIT_ARGUMENTS");}
    const parse = async (flag: string): Promise<unknown> => parseProductionJsonWithoutDuplicates(await readDeploymentFile(opts.get(flag)!, 65_536));
    const prepared = await loadPreparedProductionPackage(opts.get("--prepared")!);
    const input = await parse("--input") as ContributorCommitmentInput;
    const observation = await parse("--observation") as ContributorCapacityObservation;
    const intent = createContributorCommitmentIntent(prepared, input, observation, BigInt(Math.floor(Date.now() / 1000)));
    await writeFile(opts.get("--output")!, `${canonicalJson(intent)}\n`, { flag: "wx", mode: 0o600 });
    process.stdout.write(`Unsigned contributor grant intent ${intent.intentDigest}\nSafe ${input.projectControllerSafe} nonce ${input.safeNonce} on chain ${input.chainId}\nCALL ${intent.safeTransaction.to} value 0; beneficiary ${input.beneficiary}; amount ${input.amountBaseUnits} base units\nSchedule ${input.schedule.start} / ${input.schedule.cliff} / ${input.schedule.end} UTC seconds\nSupplied state at block ${observation.blockNumber} (${observation.blockHash}); remaining cap if executed ${intent.capacityAfterIfExecutedBaseUnits} base units\nObservation is supplied and unverified. No funds or cap are reserved. No signing or broadcast.\nArtifact: ${opts.get("--output")}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "invalid", broadcastAllowed: false, reason: error instanceof Error ? error.message : "COMMIT_FAILURE" })}\n`);
    return 2;
  }
}
if (process.argv[1]?.endsWith("contributor-commitment.ts")) {process.exitCode = await contributorCommitmentCli(process.argv.slice(2));}
