import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessPort } from "../application/ports.ts";
import { IMAGE } from "../adapters/container-contract.ts";

export async function pullPinnedImage(port: ProcessPort, dockerPath: string): Promise<boolean> {
  const dockerConfig = await mkdtemp(join(tmpdir(), "agtmai-docker-config-"));
  await chmod(dockerConfig, 0o700);
  try {
    // An empty owned config prevents Docker Desktop from invoking a host
    // credential helper while pulling this public digest-pinned image.
    await writeFile(join(dockerConfig, "config.json"), "{\"auths\":{}}\n", { mode: 0o600, flag: "wx" });
    const result = await port.run(
      dockerPath,
      ["pull", "--platform", "linux/amd64", IMAGE],
      600_000,
      { env: { PATH: "/usr/bin:/bin", DOCKER_CONFIG: dockerConfig } },
    );
    return !result.timedOut && result.exitCode === 0;
  } finally {
    await rm(dockerConfig, { recursive: true, force: true });
  }
}
