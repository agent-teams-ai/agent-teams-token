import { createHash } from "node:crypto";
import type { Finding, SourceLocation } from "../domain/model.ts";

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeIdentity(value: string): string {
  return value.replaceAll("\\", "/").replace(/\s+/gu, " ").trim();
}

export function normalizeRepositoryPath(value: string): string {
  const path = value.replaceAll("\\", "/");
  const marker = "/contracts/evm/";
  const offset = path.lastIndexOf(marker);
  const normalized = offset >= 0 ? path.slice(offset + 1) : path.replace(/^\.\//u, "");
  if (normalized.startsWith("/") || normalized.includes("/../") || normalized.startsWith("../")) {
    throw new Error("source path is not repository-relative");
  }
  return normalized;
}

export function findingFingerprint(input: Omit<Finding, "fingerprint">): string {
  const canonical = [
    "agtmai-slither-finding-v1", input.detectorId, normalizeRepositoryPath(input.location.path),
    String(input.location.start), String(input.location.length), input.location.sourceHash,
    input.location.snippetHash, input.findingIdentityHash,
  ].join("\n");
  return `sha256:${sha256(canonical)}`;
}

export const normalizedIdentityHash = (identity: string): string => `sha256:${sha256(normalizeIdentity(identity))}`;

export function sourceLocation(path: string, start: number, length: number, source: string): SourceLocation {
  const bytes = Buffer.from(source);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length <= 0 || start + length > bytes.length) {
    throw new Error("invalid source offset");
  }
  return {
    path: normalizeRepositoryPath(path), start, length,
    sourceHash: `sha256:${sha256(bytes)}`,
    snippetHash: `sha256:${sha256(bytes.subarray(start, start + length))}`,
  };
}
