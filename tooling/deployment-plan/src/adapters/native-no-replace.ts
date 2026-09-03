import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { NoReplaceDirectoryRename } from "./safe-output.ts";
import { sha256Hex } from "../domain/identity.ts";
import { fail } from "../domain/model.ts";

const SOURCE_SHA256 = "0xdca72d3308cf66b7aed9fdc0a131777990845dd479a8a00d942a19c2ab43ee22";
const SOURCE = resolvePath(dirname(fileURLToPath(import.meta.url)), "../../native/no-replace.c");
const CHILD_TIMEOUT_MS = 10_000;

interface ExecutableIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly sha256: `0x${string}`;
}

export interface ExecutableCustodyMetadata {
  readonly isFile: boolean;
  readonly uid: number;
  readonly nlink: number;
  readonly mode: number;
}

export interface ExecutableCustodyPolicy {
  readonly expectedUid: number | undefined;
  readonly allowRootOwnedMultipleLinks: boolean;
}

export interface NativeNoReplaceCapability {
  readonly rename: NoReplaceDirectoryRename;
  readonly executableSha256: `0x${string}`;
  readonly compilerSha256: `0x${string}`;
  close(): Promise<void>;
}

/** Builds the audited helper in private custody and binds its exact executable bytes. */
export async function createNativeNoReplaceCapability(): Promise<NativeNoReplaceCapability> {
  if (process.platform !== "linux" && process.platform !== "darwin") {
    fail("OUTPUT_NO_REPLACE_UNAVAILABLE", "native no-replace helper supports only Linux and macOS");
  }
  const sourceBytes = await readFile(SOURCE);
  if (sha256Hex(sourceBytes) !== SOURCE_SHA256) {
    fail("NO_REPLACE_SOURCE_MISMATCH", "native no-replace helper source differs from its pinned digest");
  }
  const configuredCompiler = process.env.AGTMAI_CC_BINARY ?? "/usr/bin/cc";
  if (!isAbsolute(configuredCompiler)) {
    fail("NO_REPLACE_COMPILER_UNSAFE", "AGTMAI_CC_BINARY must be an absolute path");
  }
  const compiler = await realpath(configuredCompiler);
  const compilerIdentity = await executableIdentity(
    compiler,
    "NO_REPLACE_COMPILER_UNSAFE",
    process.platform === "darwin",
  );
  const custody = await realpath(await mkdtemp(join(tmpdir(), "agtmai-no-replace-")));
  await chmod(custody, 0o700);
  const executable = join(custody, "no-replace");
  try {
    await runChild(compiler, [
      "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror",
      "-o", executable, SOURCE,
    ], "NO_REPLACE_BUILD_FAILED");
    await chmod(executable, 0o500);
    const builtIdentity = await executableIdentity(executable, "NO_REPLACE_EXECUTABLE_UNSAFE");
    assertSameExecutable(
      await executableIdentity(
        compiler,
        "NO_REPLACE_COMPILER_UNSAFE",
        process.platform === "darwin",
      ),
      compilerIdentity,
      "NO_REPLACE_COMPILER_SUBSTITUTED",
    );
    let closed = false;
    return {
      executableSha256: builtIdentity.sha256,
      compilerSha256: compilerIdentity.sha256,
      async rename(source: string, target: string): Promise<void> {
        if (closed) {
          fail("NO_REPLACE_CAPABILITY_CLOSED", "native no-replace capability is closed");
        }
        assertSameExecutable(
          await executableIdentity(executable, "NO_REPLACE_EXECUTABLE_UNSAFE"),
          builtIdentity,
          "NO_REPLACE_EXECUTABLE_SUBSTITUTED",
        );
        try {
          await runChild(executable, [source, target], "NO_REPLACE_FAILED");
        } catch (error) {
          if (error instanceof ChildExitError && error.exitCode === 73) {
            const exists = new Error("target already exists") as NodeJS.ErrnoException;
            exists.code = "EEXIST";
            throw exists;
          }
          throw error;
        }
      },
      async close(): Promise<void> {
        if (!closed) {
          closed = true;
          await rm(custody, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(custody, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function isExecutableCustodySafe(
  metadata: ExecutableCustodyMetadata,
  policy: ExecutableCustodyPolicy,
): boolean {
  const ownedByCaller = policy.expectedUid !== undefined && metadata.uid === policy.expectedUid;
  const rootOwned = metadata.uid === 0;
  const linkCountSafe = metadata.nlink === 1
    || (policy.allowRootOwnedMultipleLinks && rootOwned && metadata.nlink > 1);
  return policy.expectedUid !== undefined
    && metadata.isFile
    && linkCountSafe
    && (ownedByCaller || rootOwned)
    && (metadata.mode & 0o022) === 0
    && (metadata.mode & constants.S_IXUSR) !== 0;
}

async function executableIdentity(
  path: string,
  code: string,
  allowRootOwnedMultipleLinks = false,
): Promise<ExecutableIdentity> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    const expectedUid = process.getuid?.();
    if (!isExecutableCustodySafe({
      isFile: metadata.isFile(),
      uid: metadata.uid,
      nlink: metadata.nlink,
      mode: metadata.mode,
    }, { expectedUid, allowRootOwnedMultipleLinks })) {
      fail(code, "native executable identity or custody is unsafe");
    }
    return {
      dev: metadata.dev,
      ino: metadata.ino,
      ctimeMs: metadata.ctimeMs,
      size: metadata.size,
      sha256: sha256Hex(await file.readFile()),
    };
  } finally {
    await file.close();
  }
}

function assertSameExecutable(
  actual: ExecutableIdentity,
  expected: ExecutableIdentity,
  code: string,
): void {
  if (
    actual.dev !== expected.dev
    || actual.ino !== expected.ino
    || actual.ctimeMs !== expected.ctimeMs
    || actual.size !== expected.size
    || actual.sha256 !== expected.sha256
  ) {
    fail(code, "native executable changed after identity verification");
  }
}

class ChildExitError extends Error {
  readonly exitCode: number | null;

  constructor(exitCode: number | null, message: string) {
    super(message);
    this.exitCode = exitCode;
  }
}

async function runChild(executable: string, arguments_: readonly string[], code: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) {stderr += chunk.toString("utf8");}
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new ChildExitError(null, `${code}: native helper timed out`));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new ChildExitError(null, `${code}: ${error.message}`));
    });
    child.once("exit", (exitCode, signal) => {
      clearTimeout(timeout);
      if (exitCode === 0 && signal === null) {
        resolve();
      } else {
        reject(new ChildExitError(
          exitCode,
          `${code}: exit=${String(exitCode)} signal=${String(signal)} stderr=${stderr.trim()}`,
        ));
      }
    });
  });
}
