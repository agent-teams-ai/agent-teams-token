import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { checkedSolcExecution } from "../runner.ts";
import {
  assertPinnedSolcSha256,
  assertPinnedSolcVersionOutput,
  containsAsciiControlCharacter,
  pinnedSolc,
} from "../toolchain.ts";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installed = join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`, "solc");

test("local EVM build selects an authenticated snapshot inside caller-owned custody", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, (context) => {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-custody-")));
  context.after(() => rmSync(custody, { recursive: true, force: true }));
  const installEntries = readdirSync(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`));
  const solc = pinnedSolc(repositoryRoot, custody);
  context.after(() => solc.close());
  solc.assertReady();
  const path = solc.path;
  assert.equal(isAbsolute(path), true);
  assert.equal(path.startsWith(`${custody}/authenticated-solc-`), true);
  assert.equal(path.endsWith("/solc"), true);
  assert.deepEqual(readdirSync(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`)), installEntries);
});

test("same-version solc substitution is rejected by the exact platform SHA-256", (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-pin-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const committed = JSON.parse(readFileSync(join(repositoryRoot, "tooling/toolchain.lock.json"), "utf8"));
  const artifact = structuredClone(committed.tools.solc.platforms[platform]);
  const tooling = join(root, "tooling");
  const install = join(root, ".tools", artifact.installDirectory);
  const custody = join(root, "custody");
  mkdirSync(tooling, { recursive: true });
  mkdirSync(install, { recursive: true, mode: 0o700 });
  mkdirSync(custody, { mode: 0o700 });
  writeFileSync(join(tooling, "toolchain.lock.json"), JSON.stringify({ tools: { solc: {
    version: "0.8.36",
    platforms: { [platform]: artifact },
  } } }));
  const substitute = Buffer.from("#!/bin/sh\necho 'Version: 0.8.36+commit.8a079791.Linux.g++'\n");
  writeFileSync(join(install, "solc"), substitute, { mode: 0o700 });
  assert.throws(() => pinnedSolc(root, custody), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
  assert.throws(() => assertPinnedSolcSha256(substitute, artifact.sha256), (cause: unknown) => cause instanceof Error
    && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CHECKSUM_MISMATCH");
});

test("unsafe and symlink solc snapshot custody are rejected before use", (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-custody-validation-")));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const unsafe = join(root, "unsafe");
  const target = join(root, "target");
  const link = join(root, "link");
  mkdirSync(unsafe, { mode: 0o700 });
  chmodSync(unsafe, 0o777);
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, link, "dir");
  for (const custody of [unsafe, link, join(repositoryRoot, ".tools")]) {
    assert.throws(() => pinnedSolc(repositoryRoot, custody), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_SOLC_CUSTODY_INVALID");
  }
});

test("canonical private custody rejects aliases, public modes, and physical .tools descendants", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-canonical-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  for (const mode of [0o755, 0o750, 0o777]) {
    const custody = join(root, `mode-${mode.toString(8)}`);
    mkdirSync(custody, {mode}); chmodSync(custody, mode);
    assert.throws(() => pinnedSolc(repositoryRoot, custody), hasCode("LOCAL_EVM_SOLC_CUSTODY_INVALID"));
  }
  const canonical = join(root, "canonical");
  const alias = join(root, "alias");
  mkdirSync(canonical, {mode: 0o700}); symlinkSync(canonical, alias, "dir");
  assert.throws(() => pinnedSolc(repositoryRoot, alias), hasCode("LOCAL_EVM_SOLC_CUSTODY_INVALID"));

  const physical = mkdtempSync(join(repositoryRoot, ".tools", "custody-regression-"));
  chmodSync(physical, 0o700);
  context.after(() => rmSync(physical, {recursive: true, force: true}));
  const ancestorAlias = join(root, "tools-alias");
  symlinkSync(join(repositoryRoot, ".tools"), ancestorAlias, "dir");
  const before = readdirSync(join(repositoryRoot, ".tools"), {recursive: true}).map(String).toSorted();
  assert.throws(() => pinnedSolc(repositoryRoot, realpathSync(physical)), hasCode("LOCAL_EVM_SOLC_CUSTODY_INVALID"));
  assert.throws(() => pinnedSolc(repositoryRoot, join(ancestorAlias, physical.split("/").at(-1)!)), hasCode("LOCAL_EVM_SOLC_CUSTODY_INVALID"));
  assert.deepEqual(readdirSync(join(repositoryRoot, ".tools"), {recursive: true}).map(String).toSorted(), before);
  assert.equal(before.some((entry) => entry.includes("authenticated-solc-")), false);
});

test("held path execution rejects injected replacement while retaining the explicit same-UID final-exec boundary", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, (context) => {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-replacement-")));
  const marker = join(custody, "decoy-called");
  context.after(() => rmSync(custody, {recursive: true, force: true}));
  const exercise = (phase: string, authenticateFirst: boolean): void => {
    const solc = pinnedSolc(repositoryRoot, custody);
    try {
      if (authenticateFirst) {solc.assertReady();}
      const original = `${solc.path}.${phase}.held`;
      const injectedHook = (): void => {
        renameSync(solc.path, original);
        writeFileSync(solc.path, `#!/bin/sh\nprintf x >> "${marker}"\n`, {mode: 0o500});
      };
      injectedHook();
      assert.throws(() => solc.assertReady(), hasCode("LOCAL_EVM_SOLC_SNAPSHOT_INVALID"));
      assert.equal(existsSync(marker), false, "the marker decoy received zero calls");
    } finally {solc.close();}
  };
  exercise("before-version", false);
  exercise("before-forge", true);
});

test("unexecutable solc reports one stable custody diagnostic", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-noexec-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const executable = join(root, "solc");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", {mode: 0o400});
  await assert.rejects(checkedSolcExecution(executable, ["--version"], {
    code: "IGNORED", signal: new AbortController().signal,
  }), hasCode("LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE"));
});

function hasCode(code: string): (cause: unknown) => boolean {
  return (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === code;
}

test("only the pinned long solc version is accepted for evidence", () => {
  assert.equal(
    assertPinnedSolcVersionOutput("solc, the solidity compiler commandline interface\nVersion: 0.8.36+commit.8a079791.Linux.g++\n"),
    "Version: 0.8.36+commit.8a079791.Linux.g++",
  );
  for (const output of ["Version: 0.8.36", "Version: 0.8.35+commit.abcdef01.Linux.g++", "Version: 0.8.36+commit.deadbeef.Linux.g++", "Version: 0.8.36+commit.8a079791.Linux.g++.forged"]) {
    assert.throws(() => assertPinnedSolcVersionOutput(output), (cause: unknown) => cause instanceof Error
      && "code" in cause && cause.code === "LOCAL_EVM_SOLC_VERSION_MISMATCH");
  }
});

test("ASCII control characters are rejected without rejecting printable or non-ASCII text", () => {
  for (const value of ["\0", "safe\0path", "\u0001", "\u001f", "\u007f"]) {
    assert.equal(containsAsciiControlCharacter(value), true, JSON.stringify(value));
  }
  for (const value of [
    "",
    "Version: 0.8.36+commit.8a079791.Linux.g++",
    "\u0020",
    "\u007e",
    "\u0080",
  ]) {
    assert.equal(containsAsciiControlCharacter(value), false, JSON.stringify(value));
  }
});
