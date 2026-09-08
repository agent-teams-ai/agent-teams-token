import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const imports = (source: string): string[] => [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]!);

test("source dependencies preserve domain to application to adapters to composition", async () => {
  const root = "tooling/security/slither/src";
  const rules: Record<string, (specifier: string) => boolean> = {
    domain: (value) => !value.startsWith("node:") && !value.includes("/application/") && !value.includes("/adapters/") && !value.includes("/composition/"),
    application: (value) => !value.startsWith("node:") && !value.includes("/adapters/") && !value.includes("/composition/"),
    adapters: (value) => !value.includes("/composition/"),
    composition: (value) => !value.startsWith("node:"),
  };
  for (const [layer, allowed] of Object.entries(rules)) {
    for (const name of await readdir(join(root, layer))) {
      if (!name.endsWith(".ts")) {continue;}
      for (const specifier of imports(await readFile(join(root, layer, name), "utf8"))) {assert.equal(allowed(specifier), true, `${layer}/${name} imports forbidden ${specifier}`);}
    }
  }
});

test("architecture rule rejects representative reverse and builtin edges", () => {
  assert.equal(imports('import {x} from "../adapters/x.ts";')[0]?.includes("/adapters/"), true);
  assert.equal(imports('import {readFile} from "node:fs/promises";')[0]?.startsWith("node:"), true);
});
