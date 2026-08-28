import { resolve } from "node:path";
import { readRegularFile } from "./safe-fs.ts";
import { LocalEvmError, type VerificationInput } from "./model.ts";
import { verifyLocalDeployment, writeEvidence } from "./verifier.ts";

const inputPath = process.argv[2];
if (!inputPath) {throw new LocalEvmError("VERIFY_INPUT_REQUIRED", "usage: node verify-cli.ts <verification-input.json>");}
const input = JSON.parse((await readRegularFile(resolve(inputPath), "VERIFICATION_INPUT")).toString("utf8")) as VerificationInput;
const report = await verifyLocalDeployment(input);
const output = await writeEvidence(input, report);
process.stdout.write(`${JSON.stringify({ ...output, status: report.exit.status, diagnostic: report.exit.code, normalizedEvidenceSha256: report.normalizedEvidenceSha256 })}\n`);
if (report.exit.status !== "passed") {process.exitCode = 1;}
