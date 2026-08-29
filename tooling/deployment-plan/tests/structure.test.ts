import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
const root = new URL("..", import.meta.url).pathname;
test("production graph exposes neither broad RPC nor signing/broadcast capability", async () => {
  const files: string[] = []; async function walk(path: string): Promise<void> { for (const entry of await readdir(path, { withFileTypes: true })) entry.isDirectory() ? await walk(join(path, entry.name)) : entry.name.endsWith(".ts") && files.push(join(path, entry.name)); } await walk(join(root, "src"));
  const source = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.doesNotMatch(source, /eth_send|sendRawTransaction|private.?key|wallet|signTransaction|signed raw transaction/iu);
  assert.doesNotMatch(await readFile(join(root, "src/domain/model.ts"), "utf8"), /node:fs|fetch|rpc|clock/iu);
  assert.doesNotMatch(await readFile(join(root, "src/domain/identity.ts"), "utf8"), /node:fs|fetch|rpc|clock/iu);
  const rpc = await readFile(join(root, "src/adapters/rpc.ts"), "utf8"); assert.match(rpc, /redirect: "manual"/u); assert.match(rpc, /RPC_METHOD_FORBIDDEN/u);
});
