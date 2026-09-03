import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { authenticateTransferredOutput } from "../src/adapters/runner.ts";
test("container transfer accepts only private owned exact regular files",async()=>{const root=await mkdtemp("/tmp/slither-transfer-");try{await chmod(root,0o700);await writeFile(join(root,"a"),"x",{mode:0o600});await authenticateTransferredOutput(root,["a"]);await writeFile(join(root,"foreign"),"x",{mode:0o600});await assert.rejects(authenticateTransferredOutput(root,["a"]));await rm(join(root,"foreign"));await chmod(join(root,"a"),0o666);await assert.rejects(authenticateTransferredOutput(root,["a"]));}finally{await rm(root,{recursive:true,force:true});}});
test("container transfer rejects linked entries",async()=>{const root=await mkdtemp("/tmp/slither-transfer-link-");try{await chmod(root,0o700);await writeFile(join(root,"real"),"x",{mode:0o600});await symlink(join(root,"real"),join(root,"a"));await assert.rejects(authenticateTransferredOutput(root,["a","real"]));}finally{await rm(root,{recursive:true,force:true});}});
