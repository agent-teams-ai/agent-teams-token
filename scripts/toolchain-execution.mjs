import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

function checkedRegularDescriptor(fd) {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) {throw new Error("TOOLCHAIN_FILE_IDENTITY_INVALID");}
  return stat;
}

function sameIdentity(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino;
}

function hashDescriptor(fd) {
  const before = checkedRegularDescriptor(fd);
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  let offset = 0;
  while (offset < before.size) {
    const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
    if (count === 0) {throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
    hash.update(chunk.subarray(0, count));
    offset += count;
  }
  const after = checkedRegularDescriptor(fd);
  if (!sameIdentity(before, after) || before.size !== after.size) {
    throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
  }
  return hash.digest("hex");
}

function openExpectedFile(path, expectedHash) {
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const identity = checkedRegularDescriptor(fd);
    const actual = hashDescriptor(fd);
    if (actual !== expectedHash) {
      throw new Error(`TOOLCHAIN_EXECUTABLE_CHECKSUM expected=${expectedHash} actual=${actual}`);
    }
    return { fd, identity, path };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertPathStillIdentifies(opened) {
  const current = lstatSync(opened.path);
  if (current.nlink !== 1 || !sameIdentity(opened.identity, current)) {
    throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
  }
}

function minimalSubprocessEnv(executableDirectories = []) {
  return {
    PATH: [...executableDirectories, "/usr/bin", "/bin"].join(":"),
    HOME: "/tmp",
    LANG: "C",
    LC_ALL: "C",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
  };
}

function sameDirectoryIdentity(left, right) {
  return left.isDirectory() && right.isDirectory() && left.dev === right.dev && left.ino === right.ino;
}

function assertPrivateDirectory(path, identity) {
  const current = lstatSync(path);
  const owned = typeof process.getuid !== "function" || current.uid === process.getuid();
  if (!sameDirectoryIdentity(identity, current) || !owned || (current.mode & 0o777) !== 0o700) {
    throw new Error("TOOLCHAIN_SNAPSHOT_DIRECTORY_INVALID");
  }
}

function inspect(path) {
  try {
    return lstatSync(path);
  } catch {
    return;
  }
}

function writeExecutableSnapshot(root, opened, leaf) {
  const path = join(root, leaf);
  const fd = openSync(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o500,
  );
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < opened.identity.size) {
      const count = readSync(
        opened.fd,
        chunk,
        0,
        Math.min(chunk.length, opened.identity.size - offset),
        offset,
      );
      if (count === 0) {throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");}
      let written = 0;
      while (written < count) {
        written += writeSync(fd, chunk, written, count - written, offset + written);
      }
      offset += count;
    }
    fchmodSync(fd, 0o500);
    return { path, identity: checkedRegularDescriptor(fd) };
  } finally {
    closeSync(fd);
  }
}

function removeExecutableSnapshot(root, rootIdentity, snapshot) {
  const currentRoot = inspect(root);
  if (!currentRoot) {return;}
  if (!sameDirectoryIdentity(rootIdentity, currentRoot)) {return;}
  const currentLeaf = snapshot && inspect(snapshot.path);
  if (currentLeaf && sameIdentity(snapshot.identity, currentLeaf)) {unlinkSync(snapshot.path);}
  const finalRoot = inspect(root);
  if (!finalRoot || !sameDirectoryIdentity(rootIdentity, finalRoot)) {return;}
  try {
    rmdirSync(root);
  } catch (error) {
    if (error?.code !== "ENOTEMPTY") {throw error;}
  }
}

function withExecutableSnapshot(opened, expectedHash, leaf, execute) {
  const root = mkdtempSync(join(tmpdir(), "agtmai-toolchain-exec-"));
  chmodSync(root, 0o700);
  const rootIdentity = lstatSync(root);
  let writtenSnapshot;
  let openedSnapshot;
  try {
    assertPrivateDirectory(root, rootIdentity);
    writtenSnapshot = writeExecutableSnapshot(root, opened, leaf);
    if (hashDescriptor(opened.fd) !== expectedHash) {
      throw new Error("TOOLCHAIN_FILE_IDENTITY_CHANGED");
    }
    assertPathStillIdentifies(opened);
    openedSnapshot = openExpectedFile(writtenSnapshot.path, expectedHash);
    if (!sameIdentity(writtenSnapshot.identity, openedSnapshot.identity)) {
      throw new Error("TOOLCHAIN_SNAPSHOT_FILE_INVALID");
    }
    if ((openedSnapshot.identity.mode & 0o777) !== 0o500) {
      throw new Error("TOOLCHAIN_SNAPSHOT_FILE_INVALID");
    }
    assertPrivateDirectory(root, rootIdentity);
    assertPathStillIdentifies(openedSnapshot);
    return execute(openedSnapshot.path);
  } finally {
    if (openedSnapshot) {
      closeSync(openedSnapshot.fd);
    }
    removeExecutableSnapshot(root, rootIdentity, openedSnapshot ?? writtenSnapshot);
  }
}

function singleLine(value) {
  return String(value).replaceAll(/\s+/g, " ").trim();
}

function checkedSpawn(result) {
  if (result.error) {
    throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED cause=${result.error.code ?? "unknown"}`);
  }
  if (result.status !== 0) {
    throw new Error(`TOOLCHAIN_VERSION_COMMAND_FAILED status=${result.status} stderr=${singleLine(result.stderr)}`);
  }
  return String(result.stdout).trim();
}

export function descriptorRoot(platform = process.platform) {
  if (platform === "linux") {return "/proc/self/fd";}
  if (platform === "darwin") {return "/dev/fd";}
  throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED platform=${platform}`);
}

export function executeVerifiedFile({ path, expectedSha256, args = [], beforeSpawn, platform = process.platform }) {
  const opened = openExpectedFile(path, expectedSha256);
  try {
    beforeSpawn?.();
    assertPathStillIdentifies(opened);
    if (platform === "darwin") {
      return withExecutableSnapshot(opened, expectedSha256, "executable", (snapshotPath) =>
        checkedSpawn(spawnSync(snapshotPath, args, {
          encoding: "utf8",
          env: minimalSubprocessEnv(),
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15_000,
        })));
    }
    return checkedSpawn(spawnSync(`${descriptorRoot(platform)}/3`, args, {
      encoding: "utf8",
      env: minimalSubprocessEnv(),
      stdio: ["ignore", "pipe", "pipe", opened.fd],
      timeout: 15_000,
    }));
  } finally {
    closeSync(opened.fd);
  }
}

export function executeOpenedNode({ node, script, args, stdio = "pipe", platform = process.platform, subprocessPath = [] }) {
  const openedNode = openExpectedFile(node.path, node.sha256);
  let openedScript;
  try {
    openedScript = openExpectedFile(script.path, script.sha256);
    assertPathStillIdentifies(openedNode);
    assertPathStillIdentifies(openedScript);
    const inherited = stdio === "inherit"
      ? ["inherit", "inherit", "inherit"]
      : ["ignore", "pipe", "pipe"];
    const descriptorDirectory = descriptorRoot(platform);
    const result = withExecutableSnapshot(openedNode, node.sha256, "node", (snapshotPath) => {
      const nodeTarget = platform === "darwin" ? snapshotPath : `${descriptorDirectory}/3`;
      const scriptTarget = platform === "darwin" ? `${descriptorDirectory}/3` : `${descriptorDirectory}/4`;
      const descriptors = platform === "darwin"
        ? [...inherited, openedScript.fd]
        : [...inherited, openedNode.fd, openedScript.fd];
      return spawnSync(nodeTarget, [scriptTarget, ...args], {
          encoding: stdio === "inherit" ? undefined : "utf8",
          env: minimalSubprocessEnv([dirname(snapshotPath), ...subprocessPath]),
          stdio: descriptors,
          timeout: stdio === "inherit" ? 1_200_000 : 15_000,
      });
    });
    if (stdio === "inherit") {
      if (result.error) {
        throw new Error(`TOOLCHAIN_DESCRIPTOR_EXECUTION_UNSUPPORTED cause=${result.error.code ?? "unknown"}`);
      }
      return result.status ?? 1;
    }
    return checkedSpawn(result);
  } finally {
    if (openedScript) {closeSync(openedScript.fd);}
    closeSync(openedNode.fd);
  }
}
