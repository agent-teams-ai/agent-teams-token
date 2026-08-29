import { writeEnvironmentFailure } from "../adapters/evidence.ts";

const output = process.env.SLITHER_EVIDENCE_DIRECTORY ?? `${process.cwd()}/slither-evidence`;
if (!output.startsWith("/")) throw new Error("absolute evidence path is required");
const candidateSha = process.env.GITHUB_SHA ?? process.env.SLITHER_CANDIDATE_SHA ?? "";
const stage = process.env.SLITHER_FAILURE_STAGE ?? "ci-prerequisite";
const errorCode = process.env.SLITHER_FAILURE_CODE ?? "CI_PREREQUISITE_FAILED";
if (!/^[0-9a-f]{40}$/u.test(candidateSha)) throw new Error("exact candidate SHA is required");
if (!/^[a-z0-9-]+$/u.test(stage) || !/^[A-Z0-9_]+$/u.test(errorCode)) throw new Error("sanitised failure metadata is required");
await writeEnvironmentFailure(output, candidateSha, stage, errorCode);
