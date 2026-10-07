import fs from "node:fs";
import { join } from "node:path";
import { fetchArtifacts, installArtifacts } from "../toolchain.mjs";
import { makeFixture } from "./toolchain-fixture.mjs";

export function fixture(context) {
  // Tiny existing archive fixtures, no dependency install or full Node archive
  // compression. Their Node entrypoint execs the actual test runtime; both
  // wrappers below are produced by the real installation code, without edits.
  const value = makeFixture();
  context.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const platform = process.platform === "darwin" ? "darwin-arm64" : "linux-x64";
  const args = { ...value, platform, offline: true };
  fetchArtifacts(args);
  installArtifacts(args);
  return { ...value, wrapper: join(value.toolsRoot, "bin/node") };
}
