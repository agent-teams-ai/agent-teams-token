import { spawn } from "node:child_process";
import type { ProcessPort, ProcessResult } from "../application/ports.ts";

export class OwnedProcess implements ProcessPort {
  async run(command: string, args: readonly string[], timeoutMs: number): Promise<ProcessResult> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, [...args], { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = ""; let timedOut = false; let settled = false;
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
      child.once("error", (error) => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
      child.once("close", (exitCode) => { clearTimeout(timer); if (!settled) { settled = true; resolve({ exitCode, stdout, stderr, timedOut }); } });
    });
  }
}
