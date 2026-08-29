import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

export async function makeTestDirectory(prefix: string): Promise<string> {
  const root = join(process.cwd(), ".local", "slither-tests");
  await mkdir(root, { recursive: true, mode: 0o700 });
  return await mkdtemp(join(root, prefix));
}
