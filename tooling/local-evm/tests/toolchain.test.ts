import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { CommandExitError, CommandSpawnError } from "../process.ts";
import { checkedForgeBuild, checkedSolcExecution, isSolcSpawnPermissionFailure } from "../runner.ts";
import {
  assertPinnedSolcSha256,
  assertPinnedSolcVersionOutput,
  assertPinnedFoundrySha256,
  containsAsciiControlCharacter,
  isSecureSolcSnapshotMetadata,
  pinnedFoundryBinaries,
  pinnedSolc,
} from "../toolchain.ts";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));
const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
const installed = join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`, "solc");

test("Foundry capability accepts only the exact pinned installation and binary bytes", (context) => {
  const binaries = pinnedFoundryBinaries(repositoryRoot);
  assert.deepEqual(Object.keys(binaries).toSorted(), ["anvil", "cast", "forge"]);
  for (const [key, value] of Object.entries(binaries)) {
    assert.equal(value, join(repositoryRoot, ".tools", `foundry-v1.8.0-${platform}`, key));
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-foundry-decoy-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const marker = join(root, "called");
  const decoy = join(root, "forge");
  const decoyBytes = Buffer.from(`#!/bin/sh\nprintf x > ${JSON.stringify(marker)}\necho 'forge Version: 1.8.0'\n`);
  writeFileSync(decoy, decoyBytes, {mode: 0o700});
  for (const value of [undefined, "forge", decoy, join(repositoryRoot, "..", "forge")]) {
    assert.throws(
      () => pinnedFoundryBinaries(repositoryRoot, {...process.env, AGTMAI_FORGE_BINARY: value}),
      hasCode("LOCAL_EVM_FOUNDRY_BINARY_PATH_INVALID"),
    );
  }
  assert.throws(
    () => assertPinnedFoundrySha256(decoyBytes, "0".repeat(64), "forge"),
    hasCode("LOCAL_EVM_FOUNDRY_CHECKSUM_MISMATCH"),
  );
  assert.equal(existsSync(marker), false, "same-version decoy receives zero calls");
});

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
  const snapshot = lstatSync(path);
  assert.equal(snapshot.isFile(), true);
  assert.equal(snapshot.isSymbolicLink(), false);
  assert.equal(snapshot.mode & 0o777, 0o500);
  assert.equal(snapshot.nlink, 1);
  assert.deepEqual(readdirSync(join(repositoryRoot, ".tools", `solc-v0.8.36-${platform}`)), installEntries);
  solc.close();
  solc.close();
  assert.throws(() => solc.assertReady(), hasCode("LOCAL_EVM_SOLC_SNAPSHOT_INVALID"));
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

test("snapshot metadata requires a regular exact-0500 single-link file", (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-snapshot-metadata-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const snapshot = join(root, "snapshot");
  const link = join(root, "snapshot-link");
  writeFileSync(snapshot, "authenticated bytes", {mode: 0o500});
  assert.equal(isSecureSolcSnapshotMetadata(lstatSync(snapshot)), true);
  chmodSync(snapshot, 0o700);
  assert.equal(isSecureSolcSnapshotMetadata(lstatSync(snapshot)), false);
  chmodSync(snapshot, 0o500);
  linkSync(snapshot, link);
  assert.equal(isSecureSolcSnapshotMetadata(lstatSync(snapshot)), false);
  rmSync(link);
  symlinkSync(snapshot, link);
  assert.equal(isSecureSolcSnapshotMetadata(lstatSync(link)), false);
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

test("held path execution rejects the complete replacement matrix while retaining the explicit same-UID final-exec boundary", {
  skip: existsSync(installed) ? false : "pinned solc is not installed",
}, (context) => {
  const custody = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-replacement-")));
  const marker = join(custody, "decoy-called");
  context.after(() => rmSync(custody, {recursive: true, force: true}));
  const exercise = (phase: string, authenticateFirst: boolean, attack: "symlink" | "hardlink" | "replacement"): void => {
    const solc = pinnedSolc(repositoryRoot, custody);
    try {
      if (authenticateFirst) {solc.assertReady();}
      const original = `${solc.path}.${phase}.held`;
      const decoy = `${solc.path}.${phase}.${attack}.decoy`;
      writeFileSync(decoy, `#!/bin/sh\nprintf x >> "${marker}"\n`, {mode: 0o500});
      if (attack === "hardlink") {
        linkSync(solc.path, `${solc.path}.${phase}.link`);
        assert.equal(isSecureSolcSnapshotMetadata(lstatSync(solc.path)), false);
      } else {
        renameSync(solc.path, original);
        if (attack === "symlink") {symlinkSync(decoy, solc.path);}
        else {writeFileSync(solc.path, readFileSync(decoy), {mode: 0o500});}
      }
      assert.throws(() => solc.assertReady(), hasCode("LOCAL_EVM_SOLC_SNAPSHOT_INVALID"));
      assert.equal(existsSync(marker), false, "the marker decoy received zero calls");
    } finally {solc.close();}
  };
  for (const [phase, authenticateFirst] of [["before-version", false], ["before-forge", true]] as const) {
    for (const attack of ["symlink", "hardlink", "replacement"] as const) {exercise(phase, authenticateFirst, attack);}
  }
});

test("direct solc maps only raw EACCES and EPERM spawn errors", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-solc-noexec-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const executable = join(root, "solc");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", {mode: 0o400});
  await assert.rejects(checkedSolcExecution(executable, ["--version"], {
    code: "IGNORED", signal: new AbortController().signal,
  }), hasCodeWithCauseKind("LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE", "spawn"));
  const eperm = Object.assign(new Error("synthetic raw spawn failure"), {code: "EPERM"});
  assert.equal(isSolcSpawnPermissionFailure(new CommandSpawnError(executable, eperm)), true);
  assert.equal(isSolcSpawnPermissionFailure(Object.assign(new Error("permission denied (os error 13)"), {code: "OTHER"})), false);
});

test("Forge maps only the exact selected child-solc launch failure", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-forge-classification-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const forge = join(root, "forge");
  const selectedSolc = join(root, "selected-solc");
  const signal = new AbortController().signal;
  const run = async (stderr: string): Promise<unknown> => {
    writeFileSync(forge, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(stderr)} >&2\nexit 1\n`, {mode: 0o700});
    return await checkedForgeBuild(forge, [], selectedSolc, {code: "LOCAL_EVM_FORGE_BUILD_FAILED", signal});
  };
  for (const message of ["Permission denied (os error 13)", "Operation not permitted (os error 1)"]) {
    await assert.rejects(run(`Error: "${selectedSolc}": ${message}`), hasCodeWithCauseKind("LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE", "exit"));
  }
  for (const stderr of [
    "unrelated Forge error: permission denied",
    "unrelated Forge error: operation not permitted",
    "unrelated Forge error: os error 1",
    "unrelated Forge error: os error 13",
    `Error: "${join(root, "other-solc")}": Permission denied (os error 13)`,
  ]) {
    await assert.rejects(run(stderr), (cause: unknown) => cause instanceof CommandExitError
      && cause.kind === "exit" && cause.code === "LOCAL_EVM_FORGE_BUILD_FAILED");
  }
});

test("Forge failures never expose unredacted stderr through throwable metadata or reports", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-forge-redaction-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const forge = join(root, "forge");
  const selectedSolc = join(root, "selected-solc");
  const syntheticHex = `0x${"ab".repeat(32)}`;
  const syntheticMnemonic = "synthetic alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo";
  const sentinels = [syntheticHex, syntheticMnemonic];
  const run = async (firstLine: string): Promise<unknown> => {
    const lines = [firstLine, syntheticHex, syntheticMnemonic].map((line) => JSON.stringify(line)).join(" ");
    writeFileSync(forge, `#!/bin/sh\nprintf '%s\\n' ${lines} >&2\nexit 1\n`, {mode: 0o700});
    return await checkedForgeBuild(forge, [], selectedSolc, {
      code: "LOCAL_EVM_FORGE_BUILD_FAILED", signal: new AbortController().signal,
    });
  };

  const generic = await rejectedCause(run("generic Forge failure"));
  assert.equal(generic instanceof CommandExitError, true);
  assert.equal((generic as CommandExitError).code, "LOCAL_EVM_FORGE_BUILD_FAILED");
  assertThrowableReportsRedacted(generic, sentinels);

  const childSolc = await rejectedCause(run(`Error: ${JSON.stringify(selectedSolc)}: Permission denied (os error 13)`));
  assert.equal(childSolc instanceof Error && "code" in childSolc && childSolc.code, "LOCAL_EVM_SOLC_EXECUTION_UNAVAILABLE");
  assert.equal(childSolc instanceof Error && childSolc.cause instanceof CommandExitError, true);
  assertThrowableReportsRedacted(childSolc, sentinels);
});

test("an unexecutable Forge remains a Forge build failure", async (context) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agtmai-forge-noexec-")));
  context.after(() => rmSync(root, {recursive: true, force: true}));
  const forge = join(root, "forge");
  writeFileSync(forge, "#!/bin/sh\nexit 0\n", {mode: 0o400});
  await assert.rejects(checkedForgeBuild(forge, [], join(root, "selected-solc"), {
    code: "LOCAL_EVM_FORGE_BUILD_FAILED", signal: new AbortController().signal,
  }), hasCodeWithCauseKind("LOCAL_EVM_FORGE_BUILD_FAILED", "spawn"));
});

function hasCodeWithCauseKind(code: string, kind: "spawn" | "exit"): (cause: unknown) => boolean {
  return (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === code
    && cause.cause instanceof Error && "kind" in cause.cause && cause.cause.kind === kind;
}

function hasCode(code: string): (cause: unknown) => boolean {
  return (cause: unknown) => cause instanceof Error && "code" in cause && cause.code === code;
}

async function rejectedCause(promise: Promise<unknown>): Promise<unknown> {
  try {await promise;}
  catch (cause) {return cause;}
  assert.fail("expected promise to reject");
}

function assertThrowableReportsRedacted(cause: unknown, sentinels: readonly string[]): void {
  const publicValues: string[] = [];
  let current = cause;
  while (current instanceof Error) {
    publicValues.push(current.message, current.stack ?? "", JSON.stringify(current));
    for (const key of Object.getOwnPropertyNames(current)) {
      publicValues.push(String((current as unknown as Record<string, unknown>)[key]));
    }
    if (current instanceof CommandExitError) {publicValues.push(current.stderr);}
    current = current.cause;
  }
  const error = cause as Error & {readonly code?: string};
  publicValues.push(
    JSON.stringify({status: "failed", diagnostic: error.code, message: error.message}),
    `${error.name}: ${error.message}`,
  );
  for (const sentinel of sentinels) {
    assert.equal(
      publicValues.some((value) => value.includes(sentinel)), false, `exposed synthetic sentinel ${sentinel}`,
    );
  }
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
