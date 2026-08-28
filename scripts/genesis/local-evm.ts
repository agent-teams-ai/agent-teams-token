#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asError } from "../../tooling/local-evm/model.ts";
import { runLocalEvm } from "../../tooling/local-evm/runner.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
try {
  const result = await runLocalEvm({ repositoryRoot: root });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (cause) {
  const error = asError(cause);
  process.stderr.write(`${JSON.stringify({ status: "failed", diagnostic: error.code, message: error.message })}\n`);
  process.exitCode = 1;
}
