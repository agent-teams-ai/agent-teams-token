import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { LocalEvmError } from "./model.ts";

export interface OwnedProcessIdentity {
  readonly pid: number;
  readonly processStart: string;
}

export async function processStartIdentity(pid: number): Promise<string> {
  if (process.platform === "linux") {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    const field = end < 0 ? undefined : stat.slice(end + 2).trim().split(/\s+/u)[19];
    if (field === undefined || !/^[0-9]+$/u.test(field)) {
      throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "Linux process start identity is unavailable");
    }
    return `linux:${field}`;
  }
  if (process.platform === "darwin") {
    const output = await new Promise<string>((resolve, reject) => {
      execFile("/bin/ps", ["-o", "lstart=", "-p", `${pid}`], { encoding: "utf8" }, (cause, stdout) => {
        if (cause) { reject(cause); } else { resolve(stdout); }
      });
    });
    if (output.trim().length === 0) {
      throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "Darwin process start identity is unavailable");
    }
    return `darwin:${Buffer.from(output.trim()).toString("hex")}`;
  }
  throw new LocalEvmError("LOCAL_EVM_PROCESS_IDENTITY", "cross-process identity is unsupported on this platform");
}

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (cause) { return (cause as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function authenticateProcess(
  identity: OwnedProcessIdentity,
): Promise<"owned" | "absent" | "reused" | "ambiguous"> {
  if (!processAlive(identity.pid)) { return "absent"; }
  try {
    return await processStartIdentity(identity.pid) === identity.processStart ? "owned" : "reused";
  } catch {
    return processAlive(identity.pid) ? "ambiguous" : "absent";
  }
}
