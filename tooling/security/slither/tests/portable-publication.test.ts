import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { copyStableExclusive, writeEnvironmentFailure } from "../src/adapters/evidence.ts";
import { schemaDirectory } from "./evidence-canonical-fixture.ts";
import { testPublication } from "./test-publication.ts";

const precondition = async (): Promise<void> => {};

async function afterDestinationSync<T>(action: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  const probe = await open("/dev/null", "r"); const prototype = Object.getPrototypeOf(probe) as {sync(): Promise<void>}; const original = prototype.sync; await probe.close();
  prototype.sync = async function (): Promise<void> {await original.call(this); await action();};
  try {return await run();} finally {prototype.sync = original;}
}

test("descriptor transfer remains bound to the opened source when its pathname is replaced", async () => {
  const parent = await mkdtemp("/tmp/slither-descriptor-replace-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "authenticated", {mode: 0o600});
    await assert.rejects(afterDestinationSync(async () => {await rm(source); await writeFile(source, "replacement", {mode: 0o600});}, async () => await copyStableExclusive(source, destination)), /staging entry changed/u);
    assert.equal(await readFile(destination, "utf8"), "authenticated");
    assert.equal(await readFile(source, "utf8"), "replacement");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("descriptor transfer rejects a destination collision without replacing or deleting it", async () => {
  const parent = await mkdtemp("/tmp/slither-descriptor-collision-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "authenticated", {mode: 0o600}); await writeFile(destination, "foreign", {mode: 0o600});
    await assert.rejects(copyStableExclusive(source, destination));
    assert.equal(await readFile(destination, "utf8"), "foreign");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("descriptor transfer rejects source mutation after copying", async () => {
  const parent = await mkdtemp("/tmp/slither-descriptor-mutation-");
  const source = join(parent, "source"); const destination = join(parent, "destination");
  try {
    await writeFile(source, "original", {mode: 0o600});
    await assert.rejects(afterDestinationSync(async () => {await writeFile(source, "changed!", {mode: 0o600});}, async () => await copyStableExclusive(source, destination)), /staging entry changed/u);
    assert.equal(await readFile(destination, "utf8"), "original");
  } finally {await rm(parent, {recursive: true, force: true});}
});

test("publication accepts a stable parent alias and remains accessible through it", async () => {
  const parent = await mkdtemp("/tmp/slither-publication-alias-"); const canonical = join(parent, "canonical"); const alias = join(parent, "alias");
  try {
    await mkdir(canonical); await symlink(canonical, alias); const output = join(alias, "bundle");
    await writeEnvironmentFailure({output, candidateSha: "d".repeat(40), stage: "image-preflight", errorCode: "IMAGE_UNAVAILABLE", schemaDirectory, assertReadyPrecondition: precondition, publication: testPublication()});
    assert.equal((await readFile(join(output, "READY"))).length, 0);
    assert.equal(JSON.parse(await readFile(join(output, "environment-failure.json"), "utf8")).ready, true);
  } finally {await rm(parent, {recursive: true, force: true});}
});
