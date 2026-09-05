import assert from "node:assert/strict";
import { link, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { DetectorInventoryDocument, GateManifest } from "../src/domain/model.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";
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

test("malformed Slither results.errors fail closed", async () => {
  const canonicalAbsence = await parseSlitherJson(
    JSON.stringify({ success: true, error: null, results: { detectors: [], errors: null } }),
    process.cwd(),
  );
  assert.deepEqual(canonicalAbsence.errors, []);
  for (const errors of ["compile failed", { message: "compile failed" }]) {
    await assert.rejects(
      parseSlitherJson(JSON.stringify({ success: true, results: { detectors: [], errors } }), process.cwd()),
      { code: "MALFORMED_JSON" },
    );
  }
  await assert.rejects(
    parseSlitherJson(JSON.stringify({ success: false, results: { errors: [{ message: "compile failed" }] } }), process.cwd()),
    { code: "MALFORMED_JSON" },
  );
});

test("malformed root.error fails closed while valid error strings are preserved", async () => {
  for (const error of ["", { message: "compile failed" }, ["compile failed"]]) {
    await assert.rejects(
      parseSlitherJson(JSON.stringify({ success: false, error }), process.cwd()),
      { code: "MALFORMED_JSON" },
    );
  }
  const parsed = await parseSlitherJson(
    JSON.stringify({ success: false, error: "root failure", results: { errors: ["result failure"] } }),
    process.cwd(),
  );
  assert.deepEqual(parsed.errors, ["result failure", "root failure"]);
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

// Byte-exact analyzer evidence exported by the unmodified ProcessPort result
// at a9ccf2603dbfb226187d7240d5d02536d108c118; copied from .tools/handoff.
// Original capture: /var/data/agtmai-goal-20260905-01a07193/slither-raw-a9ccf260.
// Image: ghcr.io/trailofbits/eth-security-toolbox:nightly-20260824
// @sha256:9c5836b2dfeecc09ca0ab537d8372eab82114d8365667356b7c9623317e282d0
// Image sourceRevision: 8cad443280f7eeb5920a901b5f58f5a91872d9aa.
// Slither 0.11.6 / crytic-compile 0.4.2; pinned Forge 1.8.0 and
// solc 0.8.36+commit.8a079791.Linux.g++. These are captured output, not
// hand-authored findings or evidence that this test ran Docker or full E2E.
const productionBytes = await readFile(new URL("fixtures/slither-0.11.6-production.json", import.meta.url));
const detectorBytes = await readFile(new URL("fixtures/slither-0.11.6-detectors.txt", import.meta.url));
const productionRaw = productionBytes.toString("utf8");
const detectorRaw = detectorBytes.toString("utf8");
const productionManifest = JSON.parse(await readFile("tooling/security/slither/production-closure.v1.json", "utf8")) as GateManifest;

interface RawDetector extends Record<string, unknown> {
  elements: { source_mapping: Record<string, unknown> }[];
}
interface CapturedOutput { success: boolean; error: null; results: { detectors: RawDetector[] } }
const capturedOutput = (): CapturedOutput => JSON.parse(productionRaw) as CapturedOutput;
const rawFinding = (detector: RawDetector): string => JSON.stringify({ success: true, error: null, results: { detectors: [detector] } });

async function syntheticFinding(t: TestContext): Promise<{ root: string; detector: RawDetector }> {
  const root = await makeTestDirectory("metadata-parser-");
  t.after(async () => {await rm(root, { recursive: true, force: true });});
  await mkdir(join(root, "contracts/evm/src"), { recursive: true });
  await writeFile(join(root, "contracts/evm/src/A.sol"), "contract A {}\n");
  return { root, detector: {
    check: "suicidal", impact: "High", confidence: "High", description: "danger", markdown: "**danger**",
    id: "a".repeat(64), first_markdown_element: "src/A.sol#L1",
    reference: "https://github.com/crytic/slither/wiki/Detector-Documentation#suicidal",
    elements: [{ source_mapping: { filename_relative: "src/A.sol", start: 0, length: 8 } }],
  } };
}

test("captured pinned Slither 0.11.6 output parses all 11 production findings", async () => {
  assert.equal(productionBytes.length, 87782);
  assert.equal(sha256(productionBytes), "8c5ec82fa3b789314c9a2675a70aaa017dafc4cd032a2ed341cd92a8bb9abb9d");
  for (const entry of productionManifest.sources) {
    assert.equal(sha256(await readFile(entry.path)), entry.sha256, entry.path);
  }
  const parsed = await parseSlitherJson(productionRaw, process.cwd());
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.findings.length, 11);
  assert.equal(new Set(parsed.findings.map((finding) => finding.fingerprint)).size, 11);
  // The existing ledger was pinned before this parser change; parsing captured
  // output must reproduce those identities without adjusting policy or triage.
  const triage = JSON.parse(await readFile("tooling/security/slither/triage.v1.json", "utf8")) as { findings: { fingerprint: string }[] };
  assert.deepEqual(parsed.findings.map((finding) => finding.fingerprint), triage.findings.map((finding) => finding.fingerprint).toSorted());
  assert.deepEqual(parsed.findings.map((finding) => finding.detectorId).toSorted(), [
    "costly-loop", "costly-loop", "cyclomatic-complexity", "naming-convention", "naming-convention",
    "pragma", "solc-version", "solc-version", "solc-version", "solc-version", "too-many-digits",
  ]);
  assert.equal(parsed.findings.filter((finding) => finding.location.path.startsWith("contracts/evm/lib/")).length, 7);
  assert.equal(parsed.findings.filter((finding) => finding.location.path === productionManifest.targets[0]!.path).length, 4);
  for (const finding of parsed.findings) {
    assert.equal(finding.impact, "Informational");
    const source = productionManifest.sources.find((entry) => entry.path === finding.location.path);
    assert.ok(source);
    assert.equal(finding.location.sourceHash, `sha256:${source.sha256}`);
  }
});

test("captured PrettyTable has exactly the detector IDs pinned by the production manifest", async () => {
  assert.equal(detectorBytes.length, 19215);
  assert.equal(sha256(detectorBytes), "68f7eb60e2e7928be0c94a5b3b9b46088649ec192a235f85098fb14f5072f4e4");
  const pinBytes = await readFile(productionManifest.detectorInventory.path);
  assert.equal(sha256(pinBytes), productionManifest.detectorInventory.sha256);
  const pin = JSON.parse(pinBytes.toString("utf8")) as DetectorInventoryDocument;
  assert.equal(pin.slitherVersion, "0.11.6");
  assert.equal(pin.detectors.length, 101);
  for (const raw of [detectorRaw, detectorRaw.replace(/\n$/u, ""), detectorRaw.replaceAll("\n", "\r\n")]) {
    assert.deepEqual(parseDetectorInventory(raw), pin.detectors);
  }
});

test("known benign metadata cannot change any normalized production finding", async () => {
  const expected = await parseSlitherJson(productionRaw, process.cwd());
  const mutations: Record<string, unknown> = {
    id: "0".repeat(64), markdown: "a different display description",
    first_markdown_element: "src/Unrelated.sol#L999-L1000",
    reference: "https://github.com/crytic/slither/wiki/Detector-Documentation#unrelated-display-link",
  };
  for (const [field, value] of Object.entries(mutations)) {
    for (const omit of [false, true]) {
      const output = capturedOutput();
      for (const detector of output.results.detectors) {
        if (omit) {delete detector[field];} else {detector[field] = value;}
      }
      assert.deepEqual(await parseSlitherJson(JSON.stringify(output), process.cwd()), expected, `${field}, omit=${omit}`);
    }
  }
  const legacy = capturedOutput();
  for (const detector of legacy.results.detectors) {
    for (const field of Object.keys(mutations)) {delete detector[field];}
  }
  assert.deepEqual(await parseSlitherJson(JSON.stringify(legacy), process.cwd()), expected);
});

test("description and verified source offsets remain fingerprint authorities", async (t) => {
  const { root, detector } = await syntheticFinding(t);
  const original = (await parseSlitherJson(rawFinding(detector), root)).findings[0]!;
  assert.equal(original.identity, "danger");
  const described = (await parseSlitherJson(rawFinding({ ...detector, description: "different danger" }), root)).findings[0]!;
  assert.notEqual(described.findingIdentityHash, original.findingIdentityHash);
  assert.notEqual(described.fingerprint, original.fingerprint);
  detector.elements[0]!.source_mapping.start = 1;
  const moved = (await parseSlitherJson(rawFinding(detector), root)).findings[0]!;
  assert.notEqual(moved.location.snippetHash, original.location.snippetHash);
  assert.notEqual(moved.fingerprint, original.fingerprint);
  await writeFile(join(root, "contracts/evm/src/A.sol"), "contract B {}\n");
  const changedSource = (await parseSlitherJson(rawFinding(detector), root)).findings[0]!;
  assert.notEqual(changedSource.location.sourceHash, moved.location.sourceHash);
  assert.notEqual(changedSource.fingerprint, moved.fingerprint);
  delete detector.description;
  assert.equal((await parseSlitherJson(rawFinding(detector), root)).findings[0]!.identity, "**danger**");
});

test("known metadata rejects malformed types, digest shapes, URLs and Markdown locations", async (t) => {
  const { root, detector } = await syntheticFinding(t);
  const wrongTypes: unknown[] = [null, false, true, 0, 1, [], {}, ["value"], ""];
  const cases: Record<string, unknown[]> = {
    id: [...wrongTypes, "a".repeat(63), "a".repeat(65), "A".repeat(64), "g".repeat(64), `sha256:${"a".repeat(64)}`, `${"a".repeat(64)}\n`],
    markdown: wrongTypes, description: wrongTypes,
    reference: [...wrongTypes, "not-a-url", "http://github.com/crytic/slither/wiki/Detector-Documentation#suicidal",
      "https://github.com.evil/crytic/slither/wiki/Detector-Documentation#suicidal",
      "https://github.com@evil/crytic/slither/wiki/Detector-Documentation#suicidal",
      "https://github.com/crytic/slither/wiki/Detector-Documentation", `${detector.reference}?query=1`,
      `${detector.reference}\n`, "https://github.com/other/slither/wiki/Detector-Documentation#suicidal"],
    first_markdown_element: [...wrongTypes, "src/A.sol", "src/A.sol#1", "src/A.sol#L0", "src/A.sol#L01",
      "src/A.sol#L2-L1", "src/A.sol#L1-L0", "src/A.sol#L1-L", "src/A.sol#L1-L02",
      "src/A.sol#L9007199254740992", "src/A.sol#L1-L9007199254740992", "src/A.sol#L1.5",
      "src/A.sol#L-1", "src/A.sol#L1\n", "src/A.sol#L1?x", "src/A.sol#L1-L2-L3",
      "../A.sol#L1", "src/../A.sol#L1", "/src/A.sol#L1", "src//A.sol#L1", "src\\A.sol#L1",
      "https://evil/A.sol#L1", "src/%2e%2e/A.sol#L1", "[A](src/A.sol#L1)", "src/A.txt#L1"],
  };
  for (const [field, values] of Object.entries(cases)) {
    for (const value of values) {
      await assert.rejects(parseSlitherJson(rawFinding({ ...detector, [field]: value }), root),
        { code: "MALFORMED_JSON" }, `${field}=${JSON.stringify(value)}`);
    }
  }
});

test("unknown detector fields and duplicate JSON metadata keys fail closed", async (t) => {
  const { root, detector } = await syntheticFinding(t);
  for (const field of ["extra", "fingerprint", "filename", "__proto__", "constructor"]) {
    await assert.rejects(parseSlitherJson(rawFinding({ ...detector, [field]: "forged" }), root), { code: "MALFORMED_JSON" });
  }
  for (const field of ["id", "first_markdown_element", "reference", "markdown", "description"]) {
    const raw = rawFinding(detector);
    const key = JSON.stringify(field);
    for (const repeated of [key, `"\\u${field.charCodeAt(0).toString(16).padStart(4, "0")}${field.slice(1)}"`]) {
      const duplicate = raw.replace(`${key}:`, `${repeated}:${JSON.stringify(detector[field])},${key}:`);
      await assert.rejects(parseSlitherJson(duplicate, root), { code: "MALFORMED_JSON" }, repeated);
    }
  }
});

test("benign metadata cannot rescue escaped source paths or invalid offsets", async (t) => {
  const { root, detector } = await syntheticFinding(t);
  const mapping = detector.elements[0]!.source_mapping;
  for (const path of ["../A.sol", "src/../../A.sol", "contracts/evm/../../A.sol", "/outside.sol", "docs/A.sol", "..\\A.sol"]) {
    mapping.filename_relative = path;
    await assert.rejects(parseSlitherJson(rawFinding(detector), root), path);
  }
  mapping.filename_relative = "src/A.sol";
  for (const field of ["start", "length"]) {
    for (const value of [-1, 0.5, "1", null, {}, Number.MAX_SAFE_INTEGER + 1, 9999]) {
      await assert.rejects(parseSlitherJson(rawFinding({ ...detector, elements: [{ source_mapping: { ...mapping, [field]: value } }] }), root));
    }
  }
  mapping.length = 0;
  await assert.rejects(parseSlitherJson(rawFinding(detector), root), /invalid source offset/u);
});

test("metadata never authorizes symlink escapes or hardlinked source files", async (t) => {
  const { root, detector } = await syntheticFinding(t);
  const sibling = await makeTestDirectory("parser-escape-target-");
  t.after(async () => {await rm(sibling, { recursive: true, force: true });});
  const source = join(root, "contracts/evm/src/A.sol");
  const outside = join(sibling, "A.sol");
  await writeFile(outside, "contract A {}\n");
  await rm(source);
  await symlink(outside, source);
  await assert.rejects(parseSlitherJson(rawFinding(detector), root), /escapes repository/u);
  await rm(source);
  await link(outside, source);
  await assert.rejects(parseSlitherJson(rawFinding(detector), root), /not a sealed file/u);
});

function replaceTableCell(raw: string, row: number, column: number, value: string): string {
  const lines = raw.split("\n");
  const cells = lines[row + 2]!.split("|");
  const width = cells[column + 1]!.length;
  cells[column + 1] = ` ${value.padEnd(width - 2)} `;
  lines[row + 2] = cells.join("|");
  return lines.join("\n");
}

test("PrettyTable rejects malformed headers, borders, cells, chatter and mixed formats", () => {
  const lines = detectorRaw.trimEnd().split("\n");
  const malformed = [
    detectorRaw.replace("Num", "No."), detectorRaw.replace("What it Detects", "What It Detects"),
    detectorRaw.replace("Confidence", "ConfidencE"), detectorRaw.replace("+-----+", "+----+"),
    detectorRaw.replaceAll("+-----+", "+====+"), detectorRaw.replace("| 1   |", "| 1  |"),
    detectorRaw.replace("Storage abiencoderv2 array", "Storage|abiencoderv2 array"),
    detectorRaw.replace("| High          | High       |", "| High         | High        |"),
    detectorRaw.replace("| 1   |", "|  1  |"), detectorRaw.replace("| 1   |", "|\t1   |"),
    detectorRaw.replace("array", "arr\u0000y"), detectorRaw.replace("array", "arr\u001by"),
    `chatter\n${detectorRaw}`, `${detectorRaw}chatter`, `${detectorRaw}\n`, `\n${detectorRaw}`,
    `${detectorRaw}${detectorRaw}`, `${detectorRaw}| 102 | extra | High | High |`,
    lines.map((line, index) => index === 3 ? "| 1 | abiencoderv2-array | High | High |" : line).join("\n"),
    lines.map((line, index) => index === 2 ? "| --- | --- | --- | --- | --- |" : line).join("\n"),
  ];
  for (const position of [0, 1, 2, 3, 50, 103, 104]) {
    malformed.push(lines.filter((_, index) => index !== position).join("\n"));
    malformed.push(lines.map((line, index) => index === position ? "" : line).join("\n"));
    malformed.push([...lines.slice(0, position), lines[position]!, ...lines.slice(position)].join("\n"));
  }
  for (const [index, raw] of malformed.entries()) {
    assert.throws(() => parseDetectorInventory(raw), { code: "DETECTOR_INVENTORY_INVALID" }, `mutation ${index}`);
  }
});

test("PrettyTable requires unique contiguous numbers and IDs and complete typed rows", () => {
  const values: [number, string[]][] = [
    [0, ["0", "2", "01", "1.0", "-1", "1e0", ""]],
    [1, ["", "Bad-id", "bad_id", "bad id", "bad--id", "-bad", "bad-", "`abiencoderv2-array`"]],
    [2, [""]], [3, ["", "high", "Critical", "H"]], [4, ["", "high", "Certain", "H"]],
  ];
  for (const [column, candidates] of values) {
    for (const value of candidates) {
      assert.throws(() => parseDetectorInventory(replaceTableCell(detectorRaw, 1, column, value)), { code: "DETECTOR_INVENTORY_INVALID" });
    }
  }
  assert.throws(() => parseDetectorInventory(replaceTableCell(detectorRaw, 2, 0, "1")), { code: "DETECTOR_INVENTORY_INVALID" });
  assert.throws(() => parseDetectorInventory(replaceTableCell(detectorRaw, 2, 1, "abiencoderv2-array")), { code: "DETECTOR_INVENTORY_INVALID" });
  assert.throws(() => parseDetectorInventory(replaceTableCell(detectorRaw, 101, 0, "102")), { code: "DETECTOR_INVENTORY_INVALID" });
  const lines = detectorRaw.trimEnd().split("\n");
  for (let row = 1; row <= 101; row += 1) {
    const omitted = lines.filter((_, index) => index !== row + 2);
    // Even a forged closing border and renumbered suffix cannot hide omission.
    const renumbered = omitted.map((line, index) => index >= 3 && index < omitted.length - 1
      ? line.replace(/^\|[^|]+\|/u, `| ${String(index - 2).padEnd(3)} |`) : line);
    assert.throws(() => parseDetectorInventory(renumbered.join("\n")), { code: "DETECTOR_INVENTORY_INVALID" });
  }
});

test("validated Markdown inventories remain supported with complete consumption", () => {
  const row = "| 1 | `suicidal` | High | High |";
  const header = "| Detector | Check | Impact | Confidence |\n| --- | --- | --- | --- |\n";
  assert.deepEqual(parseDetectorInventory(`${header}${row}\n`), ["suicidal"]);
  assert.deepEqual(parseDetectorInventory(`${row}\n| 2 | tx-origin | Low | Medium |`), ["suicidal", "tx-origin"]);
  assert.deepEqual(parseDetectorInventory("| 1 | suicidal | Destroyable contract | High | High |"), ["suicidal"]);
  for (const raw of [header, `${row} junk`, `junk\n${row}`, `${row}\n\n`, row.replace("`suicidal`", "`suicidal"),
    row.replace("High", "H"), `${header.replace("Check", "Unknown")}${row}`, `${row}\n${detectorRaw}`,
    `${header.replace("---", "-")}${row}`, `${row}\n| 2 | tx-origin | extra | Low | Medium |`,
    `${row}\n| 2 | suicidal | High | High |`, row.replace("1", "2"), row.replace("1", "01")]) {
    assert.throws(() => parseDetectorInventory(raw), { code: "DETECTOR_INVENTORY_INVALID" });
  }
});
