import type { ScratchCustody } from "./scratch-custody.ts";
import { constants, lstat, open, realpath, readdir } from "node:fs/promises";
import { SlitherGateError } from "../domain/model.ts";
import { FIXTURE_OUTPUT_FILES, PRODUCTION_OUTPUT_FILES } from "./container-contract.ts";

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 12;
const HEADER = "SLITHER_EXPORT_V1\n";
const FOOTER = "\nSLITHER_EXPORT_END\n";
export const MAX_FRAME_BYTES = 4 * Math.ceil(MAX_TOTAL_BYTES / 3) + MAX_FILES * 256;
const knownNames = new Set<string>([...PRODUCTION_OUTPUT_FILES, ...FIXTURE_OUTPUT_FILES, "failure.stage"]);

// Bounded even if the completion pipe is replaced or never closes. The
// lifecycle deadline owns a blocked open/read and the subsequent exact-ID reap.
export const COMPLETION_READER = String.raw`import os, stat, sys
fd = os.open("/work/gate-completion", os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, "rb") as pipe:
    info = os.fstat(pipe.fileno())
    if not stat.S_ISFIFO(info.st_mode) or info.st_uid != 1000 or info.st_gid != 1000 or stat.S_IMODE(info.st_mode) != 0o600:
        sys.exit(1)
    sys.stdout.buffer.write(pipe.read(32))
`;

// Only immutable image stdlib is imported (-I -S); neither site packages nor
// the analyzer's working directory/PYTHONPATH can supply exporter code.
export const OUTPUT_EXPORTER = String.raw`import base64, json, os, stat, sys
ROOT = "/work"
PROC = "/proc"
OWNER_UID = 1000
OWNER_GID = 1000
MAX_FILE = ${MAX_FILE_BYTES}
MAX_TOTAL = ${MAX_TOTAL_BYTES}
MAX_FRAME = ${MAX_FRAME_BYTES}

def require(ok):
    if not ok:
        raise ValueError("unsafe or changing Slither output")

def identity(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_uid, info.st_gid, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

def directory(info):
    require(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700)
    require(info.st_uid == OWNER_UID and info.st_gid == OWNER_GID)

def regular(info):
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
    require(info.st_uid == OWNER_UID and info.st_gid == OWNER_GID)
    require(stat.S_IMODE(info.st_mode) in (0o400, 0o600) and 0 <= info.st_size <= MAX_FILE)

def quiescence():
    # A completed foreground analysis must leave no live descendant, including
    # reparented/stopped writers. Reject zombie leaders too: their other
    # threads may still be live, so leader state alone cannot prove quiescence.
    leader = None
    for name in os.listdir(PROC):
        if not name.isdecimal():
            continue
        try:
            with open(PROC + "/" + name + "/stat", "rb") as source:
                fields = source.read(4096).rsplit(b") ", 1)[1].split()
        except FileNotFoundError:
            continue
        state, start = fields[0], fields[19]
        if name == "1":
            require(state == b"S" and len(os.listdir(PROC + "/1/task")) == 1)
            leader = start
        elif int(name) != os.getpid():
            require(False)
    require(leader is not None)
    return leader

def read_bytes(fd, size):
    os.lseek(fd, 0, os.SEEK_SET)
    data = bytearray()
    while len(data) <= size:
        chunk = os.read(fd, min(65536, size + 1 - len(data)))
        if not chunk:
            break
        data.extend(chunk)
    require(len(data) == size)
    return bytes(data)

def snapshot(work, output, names, leader):
    before = identity(os.fstat(output))
    files = []
    try:
        total = 0
        for name in names:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=output)
            files.append([name, fd, None, None])
            info = os.fstat(fd)
            regular(info)
            total += info.st_size
            require(total <= MAX_TOTAL)
            files[-1][2:] = [identity(info), read_bytes(fd, info.st_size)]
        # Keep every descriptor until a second complete read and all path,
        # membership, timestamp and process checks have passed.
        for name, fd, info, data in files:
            require(read_bytes(fd, len(data)) == data)
            require(identity(os.fstat(fd)) == info)
            require(identity(os.stat(name, dir_fd=output, follow_symlinks=False)) == info)
        require(sorted(os.listdir(output)) == names and identity(os.fstat(output)) == before)
        require(identity(os.stat("gate-output", dir_fd=work, follow_symlinks=False)) == before)
        directory(os.fstat(work))
        require(identity(os.stat(ROOT, follow_symlinks=False)) == identity(os.fstat(work)))
        require(quiescence() == leader)
        return [[name, len(data), base64.b64encode(data).decode("ascii")] for name, fd, info, data in files]
    finally:
        for name, fd, info, data in files:
            os.close(fd)

def export():
    allowed, exact = json.loads(sys.argv[1]), sys.argv[2] == "exact"
    require(0 < len(allowed) <= ${MAX_FILES} and len(set(allowed)) == len(allowed))
    require(all(isinstance(name, str) and 0 < len(name) <= 64 and all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_" for c in name) and name not in (".", "..") for name in allowed))
    leader = quiescence()
    work = os.open(ROOT, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        directory(os.fstat(work))
        output = os.open("gate-output", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=work)
        try:
            directory(os.fstat(output))
            names = sorted(os.listdir(output))
            require(0 < len(names) <= ${MAX_FILES} and set(names) <= set(allowed))
            require(not exact or names == sorted(allowed))
            rows = snapshot(work, output, names, leader)
        finally:
            os.close(output)
    finally:
        os.close(work)
    frame = "SLITHER_EXPORT_V1\n" + json.dumps(rows, separators=(",", ":"), ensure_ascii=True) + "\nSLITHER_EXPORT_END\n"
    require(len(frame) <= MAX_FRAME)
    # This is a checked snapshot, not an atomic freeze. Same-UID hostile code
    # can race the final census/stat/write; no pause-level immutability claim.
    sys.stdout.write(frame)

try:
    export()
except Exception:
    sys.stderr.write("SLITHER_EXPORT_FAILED\n")
    sys.exit(1)
`;

function assertAllowlist(allowlist: readonly string[]): void {
  if (allowlist.length === 0 || allowlist.length > MAX_FILES || new Set(allowlist).size !== allowlist.length || allowlist.some((name) => !knownNames.has(name))) {throw invalidExport();}
}

export function exportArguments(id: string, allowlist: readonly string[], exact: boolean): readonly string[] {
  assertAllowlist(allowlist);
  return ["exec", id, "/usr/bin/python3", "-I", "-S", "-c", OUTPUT_EXPORTER, JSON.stringify(allowlist), exact ? "exact" : "partial"];
}

interface ExportedFile { readonly name: string; readonly bytes: Buffer }

function decodeRow(row: unknown, allowed: ReadonlySet<string>): ExportedFile {
  if (!Array.isArray(row) || row.length !== 3) {throw invalidExport();}
  const [name, size, encoded] = row as unknown[];
  if (typeof name !== "string" || !allowed.has(name) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) {throw invalidExport();}
  if (typeof encoded !== "string" || encoded.length !== 4 * Math.ceil(size / 3)) {throw invalidExport();}
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== size || bytes.toString("base64") !== encoded) {throw invalidExport();}
  return {name, bytes};
}

function decodeOutput(raw: string, allowlist: readonly string[], exact: boolean): readonly ExportedFile[] {
  assertAllowlist(allowlist);
  if (raw.length > MAX_FRAME_BYTES || !raw.startsWith(HEADER) || !raw.endsWith(FOOTER)) {throw invalidExport();}
  const body = raw.slice(HEADER.length, -FOOTER.length);
  const rows: unknown = JSON.parse(body);
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_FILES || JSON.stringify(rows) !== body) {throw invalidExport();}
  const allowed = new Set(allowlist);
  const files = rows.map((row: unknown) => decodeRow(row, allowed));
  const names = files.map(({name}) => name);
  if (new Set(names).size !== names.length || JSON.stringify(names) !== JSON.stringify(names.toSorted())) {throw invalidExport();}
  if (exact && JSON.stringify(names) !== JSON.stringify(allowlist.toSorted())) {throw invalidExport();}
  if (files.reduce((total, {bytes}) => total + bytes.length, 0) > MAX_TOTAL_BYTES) {throw invalidExport();}
  return files;
}

// This filesystem capability is supplied by trusted composition, never by
// container output. Portable tests substitute only descriptor path access;
// decoding, directory validation and exclusive file creation still execute.
export type OutputDirectoryPath = (fd: number, directory: string) => string;

export function linuxOutputDirectoryPath(fd: number): string {
  if (process.platform !== "linux") {throw new SlitherGateError("ARTIFACT_EXPORT_FAILED", "descriptor-anchored output requires Linux procfs");}
  return `/proc/self/fd/${fd}`;
}

export async function receiveOutput(raw: string, directory: string, allowlist: readonly string[], exact: boolean, directoryPath: OutputDirectoryPath = linuxOutputDirectoryPath, custody?: ScratchCustody): Promise<void> {
  try {
    // Validate the entire frame before creating any host file. The existing
    // ProcessPort is buffered; the trusted producer bounds bytes at source.
    const files = decodeOutput(raw, allowlist, exact);
    await writeOutput(directory, files, directoryPath, custody);
  } catch (cause) {
    const failure = invalidExport();
    failure.cause = cause;
    throw failure;
  }
}

async function writeOutput(directory: string, files: readonly ExportedFile[], directoryPath: OutputDirectoryPath, custody?: ScratchCustody): Promise<void> {
  await custody?.assert(directory);
  if (await realpath(directory) !== directory) {throw invalidExport();}
  const root = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await custody?.assertHandle(directory, root);
    const before = await root.stat({bigint: true});
    if (!before.isDirectory() || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o7777n) !== 0o700n) {throw invalidExport();}
    const anchored = directoryPath(root.fd, directory);
    // readdir through the held descriptor also confines exclusive creation.
    if ((await readdir(anchored)).length !== 0) {throw invalidExport();}
    for (const {name, bytes} of files) {
      const handle = await open(`${anchored}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {await custody?.file(`${directory}/${name}`, handle); await handle.writeFile(bytes);} finally {await handle.close();}
    }
    const after = await lstat(directory, {bigint: true});
    if (after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode || after.uid !== before.uid) {throw invalidExport();}
  } finally {await root.close();}
}

function invalidExport(): SlitherGateError {
  return new SlitherGateError("ARTIFACT_EXPORT_FAILED", "container output frame or host destination is unsafe");
}
