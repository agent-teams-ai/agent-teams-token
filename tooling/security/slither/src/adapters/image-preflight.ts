import type { ProcessPort } from "../application/ports.ts";
import { IMAGE } from "../adapters/container-contract.ts";

export async function pullPinnedImage(port: ProcessPort, dockerPath: string): Promise<boolean> {
  const result = await port.run(dockerPath, ["pull", "--platform", "linux/amd64", IMAGE], 600_000);
  return !result.timedOut && result.exitCode === 0;
}
