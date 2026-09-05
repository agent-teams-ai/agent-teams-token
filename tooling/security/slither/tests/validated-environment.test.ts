import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { validateEnvironment, validateEvidenceEnvironment, validateExternalTempRoot } from "../src/adapters/validated-environment.ts";
import { makeTestDirectory } from "./test-directory.ts";
test("environment validation canonicalizes paths and rejects checkout-contained output",async()=>{const root=await mkdtemp("/tmp/slither-env-root-");const outside=await mkdtemp("/tmp/slither-env-out-");try{const valid=await validateEnvironment(root,["a".repeat(40)],join(outside,"bundle"));assert.equal(valid.repositoryRoot,await realpath(root));await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(root,"bundle")));await assert.rejects(validateEnvironment(root,["a".repeat(40),"b".repeat(40)],join(outside,"bundle")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});
test("TMPDIR equal to or symlinked into checkout fails closed",async()=>{const root=await mkdtemp("/tmp/slither-tmp-root-");const outside=await mkdtemp("/tmp/slither-tmp-out-");try{await assert.rejects(validateExternalTempRoot(root,root));await mkdir(join(root,"tmp"));await symlink(join(root,"tmp"),join(outside,"redirect"));await assert.rejects(validateExternalTempRoot(root,join(outside,"redirect")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});

test("environment validation accepts a stable parent alias and returns the canonical leaf",async()=>{
  const root=await mkdtemp("/tmp/slither-env-alias-root-");const outside=await mkdtemp("/tmp/slither-env-alias-out-");
  try{const canonical=join(outside,"canonical");const alias=join(outside,"alias");await mkdir(canonical);await symlink(canonical,alias);const validated=await validateEnvironment(root,["a".repeat(40)],join(alias,"bundle"));assert.equal(validated.output,join(await realpath(canonical),"bundle"));await writeFile(validated.output,"occupied");await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(alias,"bundle")));}
  finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test("environment validation rejects traversal and separator-bearing leaves",async()=>{const root=await mkdtemp("/tmp/slither-env-leaf-root-");const outside=await mkdtemp("/tmp/slither-env-leaf-out-");try{await mkdir(join(outside,"child"));await assert.rejects(validateEnvironment(root,["a".repeat(40)],`${outside}/child/../bundle`));await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(outside,"bad\\leaf")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});

test("producer reserves an absent path while the consumer requires an existing regular directory", async () => {
  const parent = await makeTestDirectory("environment-contract-");
  const root = join(parent, "repository");
  const output = join(parent, "bundle");
  try {
    await mkdir(root);
    const reserved = await validateEnvironment(root, ["a".repeat(40)], output);
    assert.equal(reserved.output, output);
    await assert.rejects(validateEvidenceEnvironment(root, ["a".repeat(40)], output), { code: "ABSOLUTE_PATH_REQUIRED" });
    await mkdir(output);
    assert.deepEqual(await validateEvidenceEnvironment(root, ["a".repeat(40)], output), reserved);
    await assert.rejects(validateEnvironment(root, ["a".repeat(40)], output), { code: "ABSOLUTE_PATH_REQUIRED" });
    await rm(output, { recursive: true });
    await writeFile(output, "occupied");
    await assert.rejects(validateEvidenceEnvironment(root, ["a".repeat(40)], output), { code: "ABSOLUTE_PATH_REQUIRED" });
    await assert.rejects(validateEnvironment(root, ["a".repeat(40)], output), { code: "ABSOLUTE_PATH_REQUIRED" });
  } finally {await rm(parent, { recursive: true, force: true });}
});

test("both environment contracts canonicalize parent aliases and reject leaf aliases and traversal", async () => {
  const parent = await makeTestDirectory("environment-consumer-alias-");
  const root = join(parent, "repository");
  const canonical = join(parent, "canonical");
  const alias = join(parent, "alias");
  try {
    await mkdir(root); await mkdir(canonical); await symlink(canonical, alias);
    const output = join(canonical, "bundle");
    assert.equal((await validateEnvironment(root, ["a".repeat(40)], join(alias, "bundle"))).output, output);
    await mkdir(output);
    assert.equal((await validateEvidenceEnvironment(root, ["a".repeat(40)], join(alias, "bundle"))).output, output);
    await symlink(output, join(parent, "leaf-alias"));
    await symlink(join(parent, "missing"), join(parent, "dangling"));
    await symlink(root, join(parent, "repository-alias"));
    for (const validate of [validateEnvironment, validateEvidenceEnvironment]) {
      for (const path of [join(parent, "leaf-alias"), join(parent, "dangling"), `${output}/.`, `${output}/`,
        `${canonical}/../canonical/bundle`, join(parent, "bad\\leaf"), "relative", `${parent}/null\0leaf`]) {
        await assert.rejects(validate(root, ["a".repeat(40)], path), { code: "ABSOLUTE_PATH_REQUIRED" });
      }
      await assert.rejects(validate(root, ["a".repeat(40)], join(parent, "repository-alias/bundle")), { code: "EVIDENCE_INSIDE_REPOSITORY" });
      await assert.rejects(validate(root, ["a".repeat(40)], root), { code: "EVIDENCE_INSIDE_REPOSITORY" });
      await assert.rejects(validate(root, ["a".repeat(40), "b".repeat(40)], output), { code: "CANDIDATE_SHA_INVALID" });
      await assert.rejects(validate(root, ["A".repeat(40)], output), { code: "CANDIDATE_SHA_INVALID" });
    }
  } finally {await rm(parent, { recursive: true, force: true });}
});
