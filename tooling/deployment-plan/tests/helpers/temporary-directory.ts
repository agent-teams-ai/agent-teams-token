import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const inheritedTemporaryDirectory = process.env.TMPDIR;
const suiteTemporaryDirectory = await realpath(
  await mkdtemp(join(tmpdir(), "deployment-plan-test-suite-")),
);
process.env.TMPDIR = suiteTemporaryDirectory;

after(async () => {
  if (inheritedTemporaryDirectory === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = inheritedTemporaryDirectory;
  }
  await rm(suiteTemporaryDirectory, { recursive: true, force: true });
});

export async function ownedTemporaryDirectory(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(suiteTemporaryDirectory, prefix)));
}
