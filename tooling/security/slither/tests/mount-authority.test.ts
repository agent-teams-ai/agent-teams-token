import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACQUIRE_MOUNTS, mountAcquisitionArguments } from "../src/adapters/mount-authority.ts";
import { sha256 } from "../src/adapters/fingerprint.ts";

for (const substitution of ["forge", "solc", "input", "none"]) {
  test(`mounted acquisition ${substitution}: private consumed bytes are authenticated`, async () => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "slither-mount-authority-"));
    try {
      for (const name of ["tools", "input", "work"]) { await mkdir(join(root, name)); }
      await mkdir(join(root, "work/tools"), { mode: 0o700 });
      const authority = { forge: sha256("forge"), solc: sha256("solc"), inputs: { "source.sol": sha256("source") } };
      await writeFile(join(root, "tools/forge"), "forge");
      await writeFile(join(root, "tools/solc"), "solc");
      await writeFile(join(root, "input/source.sol"), "source");
      const path = join(root, substitution === "input" ? "input/source.sol" : `tools/${substitution}`);
      if (substitution !== "none") {
        await rename(path, `${path}-authenticated`);
        await writeFile(path, "substituted");
      }
      const args = mountAcquisitionArguments("a".repeat(64), authority);
      assert.deepEqual(args.slice(0, 6), ["exec", "a".repeat(64), "/usr/bin/python3", "-I", "-S", "-c"]);
      // Same emitted stdlib acquisition program; only absolute roots are relocated.
      const script = ACQUIRE_MOUNTS.replaceAll('"/tools/', `"${root}/tools/`).replaceAll('"/input/', `"${root}/input/`).replaceAll('"/work/', `"${root}/work/`);
      const result = spawnSync("/usr/bin/python3", ["-I", "-S", "-c", script, JSON.stringify(authority)], { encoding: "utf8" });
      if (substitution === "none") {
        assert.equal(result.status, 0, result.stderr);
        await writeFile(join(root, "input/source.sol"), "later replacement");
        await writeFile(join(root, "tools/forge"), "later replacement");
        await writeFile(join(root, "tools/solc"), "later replacement");
        assert.equal(await readFile(join(root, "work/input/source.sol"), "utf8"), "source");
        assert.equal(await readFile(join(root, "work/tools/forge"), "utf8"), "forge");
        assert.equal(await readFile(join(root, "work/tools/solc"), "utf8"), "solc");
      } else { assert.notEqual(result.status, 0); assert.match(result.stderr, /mounted authority differs/u); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
