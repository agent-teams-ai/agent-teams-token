import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { publishDeploymentFiles, readDeploymentFile, verifyDeploymentFiles } from "../src/features/genesis-manifest/adapters/deployment-store.js";

async function temporary(): Promise<string> {
  const parent = resolve("../../../.local/deployment-store-tests");
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, "case-"));
}

test("exclusive durable publication and hash inventory detect altered, missing, extra and linked evidence", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), bytes = new TextEncoder().encode('{"broadcastAllowed":false}');
  const files = { "result.json": bytes };
  const inventory = await publishDeploymentFiles(output, files);
  assert.deepEqual(await verifyDeploymentFiles(output), inventory);
  assert.equal(inventory.files.some(f => f.name === "inventory.json"), false);
  await assert.rejects(publishDeploymentFiles(output, files));
  assert.deepEqual(await publishDeploymentFiles(output, files, true), inventory);
  await writeFile(join(output, "result.json"), "tamper");
  await assert.rejects(verifyDeploymentFiles(output), /MISMATCH/);
  await assert.rejects(publishDeploymentFiles(output, files, true), /RESUME_MISMATCH/);
  await rm(join(output, "result.json"));
  await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
  await writeFile(join(root, "external.json"), bytes);
  await symlink(join(root, "external.json"), join(output, "result.json"));
  await assert.rejects(verifyDeploymentFiles(output));
  await assert.rejects(readDeploymentFile(join(output, "result.json")));
});

test("partial publication can resume without overwriting inputs or repeating external work", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "bundle"), bytes = new TextEncoder().encode("known-output");
  await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, "first.json"), bytes, { flag: "wx", mode: 0o600 });
  await publishDeploymentFiles(output, { "first.json": bytes, "second.json": bytes }, true);
  assert.equal((await verifyDeploymentFiles(output)).files.length, 2);
  assert.equal(await readFile(join(output, "first.json"), "utf8"), "known-output");
  await writeFile(join(output, "unexpected.json"), "surprise");
  await assert.rejects(verifyDeploymentFiles(output), /INVENTORY_FILES/);
});

test("bounded reads and crash locks fail closed", async context => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "large.json"), "12345");
  await assert.rejects(readDeploymentFile(join(root, "large.json"), 4), /BOUND/);
  const output = join(root, "bundle"); await mkdir(output, { mode: 0o700 });
  await writeFile(join(output, ".publication-lock"), "old lock");
  await assert.rejects(publishDeploymentFiles(output, { "result.json": new Uint8Array() }, true));
  assert.equal(await readFile(join(output, ".publication-lock"), "utf8"), "old lock");
});
