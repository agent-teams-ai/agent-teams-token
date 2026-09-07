import { SlitherGateError } from "../domain/model.ts";

export interface MountAuthority {
  readonly forge: string;
  readonly solc: string;
  readonly inputs: Readonly<Record<string, string>>;
}

/** Image stdlib acquires each mounted file once, then hashes the private copy used. */
export const ACQUIRE_MOUNTS = String.raw`import hashlib, json, os, stat, sys
expected = json.loads(sys.argv[1])
def require(value):
    if not value:
        raise ValueError("mounted authority differs")
def copy(source, destination, digest, executable=False):
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1)
        require(0 < before.st_size <= 256 * 1024 * 1024)
        os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
        out = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o700 if executable else 0o600)
        try:
            total = 0
            with os.fdopen(out, "wb", closefd=False) as stream:
                while True:
                    chunk = os.read(fd, 65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    require(total <= before.st_size)
                    stream.write(chunk)
            require(total == before.st_size)
            after = os.fstat(fd)
            require((before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_size, after.st_mtime_ns, after.st_ctime_ns))
            os.fchmod(out, 0o500 if executable else 0o400)
        finally:
            os.close(out)
        with open(destination, "rb") as snapshot:
            captured = hashlib.sha256()
            while True:
                chunk = snapshot.read(65536)
                if not chunk:
                    break
                captured.update(chunk)
            require(captured.hexdigest() == digest)
    finally:
        os.close(fd)
require(len(expected["inputs"]) > 0)
os.mkdir("/work/input", 0o700)
os.mkdir("/work/tools", 0o700)
copy("/tools/forge", "/work/tools/forge", expected["forge"], True)
copy("/tools/solc", "/work/tools/solc", expected["solc"], True)
for path, digest in expected["inputs"].items():
    copy("/input/" + path, "/work/input/" + path, digest)
`;

export function mountAcquisitionArguments(id: string, authority: MountAuthority): readonly string[] {
  for (const [path, hash] of Object.entries(authority.inputs)) {
    if (!/^[A-Za-z0-9._/-]+$/u.test(path) || path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "." || part === "") || !/^[0-9a-f]{64}$/u.test(hash)) { throw invalid(); }
  }
  if (!/^[0-9a-f]{64}$/u.test(authority.forge) || !/^[0-9a-f]{64}$/u.test(authority.solc) || Object.keys(authority.inputs).length === 0) { throw invalid(); }
  return ["exec", id, "/usr/bin/python3", "-I", "-S", "-c", ACQUIRE_MOUNTS, JSON.stringify(authority)];
}
function invalid(): SlitherGateError { return new SlitherGateError("INPUT_HASH_MISMATCH", "mounted input authority is invalid"); }
