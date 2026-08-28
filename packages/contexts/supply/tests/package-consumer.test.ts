import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

test("black-box consumer can use only the declared genesis-manifest subpath", async (context) => {
  const packageRoot = process.cwd().endsWith("/packages/contexts/supply") ? process.cwd() : resolvePath(process.cwd(), "packages/contexts/supply"), repositoryRoot = resolvePath(packageRoot, "../../.."), consumer = join(repositoryRoot, ".local/package-consumer"), scope = join(consumer, "node_modules/@agent-teams");
  context.after(() => rm(consumer, { force: true, recursive: true })); await mkdir(scope, { recursive: true }); await symlink(packageRoot, join(scope, "supply"));
  const entry = join(consumer, "consumer.mjs"); await writeFile(entry, 'import * as manifest from "@agent-teams/supply/genesis-manifest"; if (manifest.ALLOCATION_DOMAIN.length !== 66 || !manifest.encodeAllocationId("test-alpha") || "compileLocalSource" in manifest) process.exit(2);\n');
  assert.equal(await exitCode(entry), 0);
  await writeFile(entry, 'import { compileLocalSource } from "@agent-teams/supply/genesis-manifest"; void compileLocalSource;\n'); assert.notEqual(await exitCode(entry), 0);
  await writeFile(entry, 'import "@agent-teams/supply/domain/model.js";\n'); assert.notEqual(await exitCode(entry), 0);
});

async function exitCode(entry: string): Promise<number | null> { return new Promise((resolve, reject) => { const child = spawn(process.execPath, [entry], { stdio: "ignore" }); child.on("error", reject); child.on("close", resolve); }); }
