import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { validateEnvironment, validateExternalTempRoot } from "../src/adapters/validated-environment.ts";
test("environment validation canonicalizes paths and rejects checkout-contained output",async()=>{const root=await mkdtemp("/tmp/slither-env-root-");const outside=await mkdtemp("/tmp/slither-env-out-");try{const valid=await validateEnvironment(root,["a".repeat(40)],join(outside,"bundle"));assert.equal(valid.repositoryRoot,root);await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(root,"bundle")));await assert.rejects(validateEnvironment(root,["a".repeat(40),"b".repeat(40)],join(outside,"bundle")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});
test("TMPDIR equal to or symlinked into checkout fails closed",async()=>{const root=await mkdtemp("/tmp/slither-tmp-root-");const outside=await mkdtemp("/tmp/slither-tmp-out-");try{await assert.rejects(validateExternalTempRoot(root,root));await mkdir(join(root,"tmp"));await symlink(join(root,"tmp"),join(outside,"redirect"));await assert.rejects(validateExternalTempRoot(root,join(outside,"redirect")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});

test("environment validation accepts a stable parent alias and returns the canonical leaf",async()=>{
  const root=await mkdtemp("/tmp/slither-env-alias-root-");const outside=await mkdtemp("/tmp/slither-env-alias-out-");
  try{const canonical=join(outside,"canonical");const alias=join(outside,"alias");await mkdir(canonical);await symlink(canonical,alias);const validated=await validateEnvironment(root,["a".repeat(40)],join(alias,"bundle"));assert.equal(validated.output,join(canonical,"bundle"));await writeFile(validated.output,"occupied");await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(alias,"bundle")));}
  finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
});
test("environment validation rejects traversal and separator-bearing leaves",async()=>{const root=await mkdtemp("/tmp/slither-env-leaf-root-");const outside=await mkdtemp("/tmp/slither-env-leaf-out-");try{await mkdir(join(outside,"child"));await assert.rejects(validateEnvironment(root,["a".repeat(40)],`${outside}/child/../bundle`));await assert.rejects(validateEnvironment(root,["a".repeat(40)],join(outside,"bad\\leaf")));}finally{await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}});
