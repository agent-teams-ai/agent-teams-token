import { nativeNoReplaceApprovalSha256 } from "../src/adapters/native-no-replace.ts";
import { canonicalJson } from "../src/domain/identity.ts";
import type { NativeNoReplaceEvidence, NativeNoReplaceEvidenceFields, NativeNoReplacePolicy } from "../src/application/ports.ts";

export const nativeNoReplacePolicy: NativeNoReplacePolicy = {
  schemaVersion: 1,
  kind: "native-no-replace-build-policy",
  sourcePath: "tooling/deployment-plan/native/no-replace.c",
  sourceSha256: "0xf3bd0279809e011933eb6ed92d55c2c7ee3bb28dedb2294ea47fe49a25483f09",
  compileProfile: "c11-o2-werror-stdin-v1",
  platforms: {
    "darwin-arm64": { strategy: "verified-path", tuples: [{ compilerPath: "/usr/bin/cc", compilerSha256: "0x7588ceab299393618d6f8861502ac0588d1594025f301d9a61a898215b5571d3", executableSha256: "0x333d90f849c3116bf477678e9439abce54bcf2eed1c724652e70172f69ae584e" }] },
    "linux-x64": { strategy: "snapshot-fd", tuples: [{ compilerPath: "/usr/bin/cc", compilerSha256: "0x1b99826121ae6682a634e5efe09bd3e3df58ce58e0b28f849114ab5b89139c26", executableSha256: "0x814aba8dfb8f176c252a3fc8f4aa8564723c0790613ee101a9a45fc41f629e9b" }] },
  },
};
const fields: NativeNoReplaceEvidenceFields = {
  platform: "linux-x64", sourcePath: nativeNoReplacePolicy.sourcePath,
  sourceSha256: nativeNoReplacePolicy.sourceSha256, compileProfile: nativeNoReplacePolicy.compileProfile,
  compilerExecution: "snapshot-fd", compilerPath: "/usr/bin/cc",
  compilerSha256: nativeNoReplacePolicy.platforms["linux-x64"].tuples[0]!.compilerSha256,
  executableSha256: nativeNoReplacePolicy.platforms["linux-x64"].tuples[0]!.executableSha256,
};
export const nativeNoReplaceEvidence: NativeNoReplaceEvidence = { schemaVersion: 1, kind: "native-no-replace-evidence", ...fields, approvalSha256: nativeNoReplaceApprovalSha256(fields) };
export const nativeNoReplaceEvidenceBytes = Buffer.from(`${canonicalJson(nativeNoReplaceEvidence)}\n`);
export const nativeVerification = { nativeNoReplaceEvidenceBytes, nativeNoReplacePolicy } as const;
export const nativePublication = { nativeNoReplaceEvidence, nativeNoReplacePolicy } as const;
