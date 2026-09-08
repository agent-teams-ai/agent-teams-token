import { resolve } from "node:path";
import { readRegularFile } from "./safe-fs.ts";
import { LocalEvmError, type VerificationInput } from "./model.ts";
import { verifyLocalDeployment, writeEvidence } from "./verifier.ts";

try {
  const inputPath = process.argv[2];
  if (!inputPath) {throw new LocalEvmError("VERIFY_INPUT_REQUIRED", "verification input is required");}
  const inputBytes = await readRegularFile(resolve(inputPath), "VERIFICATION_INPUT");
  let input: VerificationInput;
  try {
    input = JSON.parse(inputBytes.toString("utf8")) as VerificationInput;
  } catch {
    throw new LocalEvmError("VERIFY_INPUT_JSON_INVALID", "verification input is invalid JSON");
  }
  const report = await verifyLocalDeployment(input);
  const output = await writeEvidence(input, report);
  process.stdout.write(`${JSON.stringify({ ...output, status: report.exit.status, diagnostic: report.exit.code, normalizedEvidenceSha256: report.normalizedEvidenceSha256 })}\n`);
  if (report.exit.status !== "passed") {process.exitCode = 1;}
} catch (cause) {
  const diagnostic = cause instanceof LocalEvmError ? cause.code : "VERIFY_INPUT_FAILURE";
  process.stdout.write(`${JSON.stringify({ status: "failed", diagnostic })}\n`);
  process.exitCode = 1;
}
