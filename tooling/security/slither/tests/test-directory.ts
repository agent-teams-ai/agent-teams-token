import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function makeTestDirectory(prefix: string): Promise<string> {
  // Keep disposable fixtures outside the repository. On macOS, os.tmpdir()
  // may be the symlinked /var path; realpath() canonicalizes it to /private/var
  // before creating the directory, matching production boundary checks.
  const root = await realpath(tmpdir());
  return await mkdtemp(join(root, `agtmai-slither-${prefix}`));
}
