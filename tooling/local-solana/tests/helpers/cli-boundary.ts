import { runCliBoundary } from "../../src/composition/index.ts";

const mode = process.argv[2];
if (mode === "success" || mode === "output-failure") {
  await runCliBoundary([], async () => ({
    jsonPath: "/private/sensitive/output/evidence-opaque-123/evidence-report.v1.json",
    markdownPath: "/private/sensitive/output/evidence-opaque-123/evidence-report.v1.md",
  }), mode === "output-failure" ? {
    stdout: () => { throw new Error("raw output failure /private/key.json http://127.0.0.1:8899/"); },
    stderr: (value) => process.stderr.write(value),
    exitCode: (value) => { process.exitCode = value; },
  } : undefined);
} else {
  await runCliBoundary([], async () => {
    throw new Error("raw post-mutation cause /private/run/payer.json http://127.0.0.1:8899/ secret RPC body");
  });
}
