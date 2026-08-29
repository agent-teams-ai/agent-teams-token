import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseDetectorInventory, parseSlitherInventory, parseSlitherJson } from "../src/adapters/slither-json.ts";
import { makeTestDirectory } from "./test-directory.ts";

test("strict parser accepts findings when Slither success is true", async () => {
  const root = await makeTestDirectory("parser-");
  try {
    await mkdir(join(root, "contracts/evm"), { recursive: true }); await writeFile(join(root, "contracts/evm/A.sol"), "contract A {}\n");
    const raw = JSON.stringify({ success: true, results: { detectors: [{ check: "suicidal", impact: "High", confidence: "High", description: "danger", elements: [{ source_mapping: { filename_relative: "contracts/evm/A.sol", start: 0, length: 8 } }] }], errors: [] } });
    const parsed = await parseSlitherJson(raw, root); assert.equal(parsed.success, true); assert.equal(parsed.findings.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parser canonicalizes Foundry compilation-relative source paths", async () => {
  const root = await makeTestDirectory("relative-parser-");
  try {
    await mkdir(join(root, "contracts/evm/src"), { recursive: true }); await writeFile(join(root, "contracts/evm/src/A.sol"), "contract A {}\n");
    const raw = JSON.stringify({ success: true, results: { detectors: [{ check: "suicidal", impact: "High", confidence: "High", description: "danger", elements: [{ source_mapping: { filename_relative: "src/A.sol", start: 0, length: 8 } }] }], errors: [] } });
    const parsed = await parseSlitherJson(raw, root); assert.equal(parsed.findings[0]?.location.path, "contracts/evm/src/A.sol");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("absolute worktree text does not change a parsed finding fingerprint", async () => {
  const roots = [await makeTestDirectory("identity-one-"), await makeTestDirectory("identity-two-")];
  try {
    const fingerprints: string[] = [];
    for (const root of roots) {
      await mkdir(join(root, "contracts/evm"), { recursive: true }); await writeFile(join(root, "contracts/evm/A.sol"), "contract A {}\n");
      const raw = JSON.stringify({ success: true, results: { detectors: [{ check: "suicidal", impact: "High", confidence: "High", description: `${root}/contracts/evm/A.sol danger`, elements: [{ source_mapping: { filename_relative: "contracts/evm/A.sol", start: 0, length: 8 } }] }], errors: [] } });
      fingerprints.push((await parseSlitherJson(raw, root)).findings[0]!.fingerprint);
    }
    assert.equal(fingerprints[0], fingerprints[1]);
  } finally { await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true }))); }
});

test("malformed JSON, omitted elements and outside paths are rejected", async () => {
  await assert.rejects(parseSlitherJson("not-json", "/tmp"));
  await assert.rejects(parseSlitherJson(JSON.stringify({ success: true, results: { detectors: [{ check: "x", impact: "High", confidence: "High", description: "x", elements: [] }] } }), "/tmp"));
  await assert.rejects(parseSlitherJson(JSON.stringify({ success: true, results: { detectors: [{ check: "x", impact: "High", confidence: "High", description: "x", elements: [{ source_mapping: { filename_relative: "/etc/passwd", start: 0, length: 1 } }] }] } }), "/tmp"));
});

test("well-formed Slither analysis errors remain tool failures, not malformed output", async () => {
  const parsed = await parseSlitherJson(JSON.stringify({ success: false, error: "compile failed" }), process.cwd());
  assert.equal(parsed.success, false); assert.deepEqual(parsed.findings, []); assert.deepEqual(parsed.errors, ["compile failed"]);
});

test("detector inventory rejects empty and duplicate tables", () => {
  assert.deepEqual(parseDetectorInventory("| 1 | suicidal | High | High |"), ["suicidal"]);
  assert.throws(() => parseDetectorInventory(""));
  assert.throws(() => parseDetectorInventory("| 1 | suicidal | H | H |\n| 2 | suicidal | H | H |"));
});

test("Slither printer inventory is the analyzed target and source authority", () => {
  const raw = JSON.stringify({ success: true, contracts: ["A"], sources: ["src/A.sol"], errors: [] });
  assert.deepEqual(parseSlitherInventory(raw), { success: true, contracts: ["A"], sources: ["src/A.sol"], errors: [] });
  assert.throws(() => parseSlitherInventory(JSON.stringify({ success: true, contracts: [], sources: [], errors: [] })), /omitted analyzed/u);
});
