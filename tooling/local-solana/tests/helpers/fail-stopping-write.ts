import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";

const originalOpen = fs.open;
const originalReadFile = fs.readFile;
let failedStat = false;
fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
  if (process.env.AGTMAI_TEST_FAIL_FIRST_STAT === "1" && !failedStat && typeof args[0] === "string"
    && /^\/proc\/[0-9]+\/stat$/u.test(args[0]) && args[0] !== `/proc/${process.pid}/stat`) {
    failedStat = true;
    throw Object.assign(new Error("injected first stat observation failure"), { code: "EIO" });
  }
  return await originalReadFile(...args);
}) as typeof fs.readFile;
fs.open = (async (...args: Parameters<typeof fs.open>) => {
  const handle = await originalOpen(...args);
  if (typeof args[0] === "string" && args[0].endsWith("/.agtmai-validator-startup.json")) {
    const write = handle.write.bind(handle);
    handle.write = (async (...values: Parameters<typeof write>) => {
      const stage = process.env.AGTMAI_TEST_FAIL_STAGE ?? "stopping";
      if (Buffer.isBuffer(values[0]) && values[0].toString("utf8").includes(`"stage":"${process.env.AGTMAI_TEST_HANG_STAGE}"`)) {
        if (process.env.AGTMAI_TEST_PID_FILE !== undefined) {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await fs.readFile(process.env.AGTMAI_TEST_PID_FILE).then(() => true, () => false)) { break; }
            await new Promise((resolve) => { setTimeout(resolve, 10); });
          }
        }
        await new Promise<never>(() => {});
      }
      if (Buffer.isBuffer(values[0]) && values[0].toString("utf8").includes(`"stage":"${stage}"`)) {
        if (stage === "spawned" && process.env.AGTMAI_TEST_PID_FILE !== undefined) {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (await fs.readFile(process.env.AGTMAI_TEST_PID_FILE).then(() => true, () => false)) { break; }
            await new Promise((resolve) => { setTimeout(resolve, 10); });
          }
        }
        throw Object.assign(new Error("injected marker write failure"), { code: "ENOSPC" });
      }
      return await write(...values);
    }) as typeof handle.write;
  }
  return handle;
}) as typeof fs.open;
syncBuiltinESMExports();
