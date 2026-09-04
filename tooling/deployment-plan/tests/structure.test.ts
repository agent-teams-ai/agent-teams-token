import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url).pathname;

test("production graph exposes neither broad RPC nor signing/broadcast capability", async () => {
  const files: string[] = [];
  await collectTypeScript(join(root, "src"), files);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const source = contents.join("\n");
  assert.doesNotMatch(
    source,
    /eth_send|sendRawTransaction|private.?key|wallet|signTransaction|signed raw transaction/iu,
  );
  await assertPureDomain("model.ts");
  await assertPureDomain("identity.ts");
  const application = await Promise.all(
    files.filter((file) => file.includes("/application/"))
      .map((file) => readFile(file, "utf8")),
  );
  assert.doesNotMatch(application.join("\n"), /\.\.\/adapters\//u);
  const composition = await readFile(join(root, "src/composition/index.ts"), "utf8");
  assert.doesNotMatch(composition, /readonly nativeNoReplacePolicy/u);
  const nativeFactory = await readFile(join(root, "src/adapters/native-no-replace.ts"), "utf8");
  assert.doesNotMatch(nativeFactory, /readonly policy\??:|evidence, policy/u);
  const rpc = await readFile(join(root, "src/adapters/rpc.ts"), "utf8");
  assert.match(rpc, /redirect: "manual"/u);
  assert.match(rpc, /RPC_METHOD_FORBIDDEN/u);
});

async function collectTypeScript(path: string, files: string[]): Promise<void> {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await collectTypeScript(child, files);
    } else if (entry.name.endsWith(".ts")) {
      files.push(child);
    }
  }
}

async function assertPureDomain(file: string): Promise<void> {
  const source = await readFile(join(root, "src/domain", file), "utf8");
  assert.doesNotMatch(source, /node:fs|fetch|rpc|clock/iu);
}
