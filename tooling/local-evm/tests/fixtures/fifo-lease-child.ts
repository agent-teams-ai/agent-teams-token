import { execFile } from "node:child_process";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { processStartIdentity } from "../../process.ts";
import { createRunLease, reclaimStaleRuns, registerRunAnvil } from "../../run-lease.ts";

const execute = promisify(execFile);
const [operation, target, displaced] = process.argv.slice(2);
let predecessor: Buffer | undefined;

try {
  if (operation === "reclaim" && target !== undefined) {
    await reclaimStaleRuns(target);
  } else if (operation === "register"
    && target !== undefined && displaced !== undefined) {
    // The registration must run as the process that owns this synthetic lease.
    await createRunLease(target);
    predecessor = await readFile(join(target, "lease.v1.json"));
    await registerRunAnvil(
      target,
      {
        pid: process.pid,
        processStart: await processStartIdentity(process.pid),
      },
      {beforePublish: async () => {
        const leasePath = join(target, "lease.v1.json");
        await rename(leasePath, displaced);
        await execute("/usr/bin/mkfifo", [leasePath]);
      }},
    );
  } else {
    throw new Error("invalid FIFO lease fixture arguments");
  }
  process.stdout.write(JSON.stringify({status: "fulfilled"}));
} catch (cause) {
  const code = cause instanceof Error && "code" in cause
    ? cause.code
    : undefined;
  const predecessorPreserved = predecessor === undefined
    ? undefined
    : predecessor.equals(await readFile(displaced!));
  process.stdout.write(JSON.stringify({status: "rejected", code, predecessorPreserved}));
}
