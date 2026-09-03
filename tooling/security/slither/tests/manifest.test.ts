import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { parseGateManifest } from "../src/adapters/runner.ts";
const base=JSON.parse(await readFile("tooling/security/slither/production-closure.v1.json","utf8")) as Record<string,unknown>;
const parse=(value:unknown)=>parseGateManifest(`${JSON.stringify(value)}\n`);
test("production manifest has exact keys and typed safe values",()=>assert.doesNotThrow(()=>parse(base)));
test("manifest rejects missing, extra, duplicate and wrong-typed keys",()=>{
  const missing={...base};delete missing.tools;assert.throws(()=>parse(missing));assert.throws(()=>parse({...base,extra:true}));assert.throws(()=>parse({...base,schemaVersion:"1"}));
  const raw=JSON.stringify(base).replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1');assert.throws(()=>parseGateManifest(raw));
});
test("manifest rejects every shell and filesystem path injection class",()=>{
  for(const path of ["/tmp/A.sol","../A.sol","contracts/evm/src/../A.sol","-option.sol","contracts/evm/src/A B.sol","contracts/evm/src/A*.sol","contracts/evm/src/A\\\\B.sol","contracts/evm/src/A\nB.sol"]){
    const value=structuredClone(base); const targets=value.targets as Record<string,unknown>[];
    targets[0]!.path=path;
    assert.throws(()=>parse(value),path);
  }
  const duplicate=structuredClone(base); const sources=duplicate.sources as Record<string,unknown>[];
  sources.push({...sources[0]}); assert.throws(()=>parse(duplicate));
});
