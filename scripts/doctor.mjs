import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const lock = JSON.parse(
  readFileSync(new URL("../tooling/toolchain.lock.json", import.meta.url), "utf8"),
);

const checks = [
  ["node", ["--version"], lock.tools.node.version],
  ["pnpm", ["--version"], lock.tools.pnpm.version],
  ["forge", ["--version"], lock.tools.foundry.version],
  ["solana", ["--version"], lock.tools.agave.version],
];

let failed = false;

for (const [command, args, expected] of checks) {
  try {
    const output = execFileSync(command, args, { encoding: "utf8" }).trim();
    const matches = output.includes(expected);
    console.log(`${matches ? "OK" : "MISMATCH"} ${command}: ${output}`);
    failed ||= !matches;
  } catch {
    console.log(`MISSING ${command}: expected ${expected}`);
    failed = true;
  }
}

if (process.env.ALLOW_PUBLIC_NETWORK === "true") {
  console.log("WARNING ALLOW_PUBLIC_NETWORK=true");
  failed = true;
} else {
  console.log("OK public networks are disabled");
}

process.exitCode = failed ? 1 : 0;

