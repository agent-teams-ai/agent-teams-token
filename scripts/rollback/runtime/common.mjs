import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { registerCustodyDescriptor } from "./custody.mjs";
export { custodyDescriptorChild as descriptorChild } from "./custody.mjs";

const SAFE_PATH = /^[^\\\0]+$/u;

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateTrackedPath(path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path) || !SAFE_PATH.test(path)
    || path === "." || path.split("/").includes("..") || path.split("/").includes(".")) {
    throw new Error("ROLLBACK_INVENTORY_PATH_UNSAFE");
  }
}

export function resolveInside(root, path) {
  if (typeof path !== "string" || path.length === 0 || isAbsolute(path)
    || path.includes("\0") || path.includes("\\")) {
    throw new Error("ROLLBACK_PATH_UNSAFE path=" + String(path));
  }
  const candidate = resolve(root, path);
  const candidateRelative = relative(root, candidate);
  if (candidateRelative === ".." || candidateRelative.startsWith(".." + sep)) {
    throw new Error("ROLLBACK_PATH_ESCAPE path=" + path);
  }
  return candidate;
}

export function splitNul(buffer) {
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      records.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.length) {
    throw new Error("ROLLBACK_NUL_RECORD_UNTERMINATED");
  }
  return records.filter((record) => record.length > 0);
}

export function safeLabel(value) {
  return String(value).replaceAll(/[^a-z0-9-]+/gu, "-").replaceAll(/^-|-$/gu, "") || "command";
}

export function tail(value, lineCount) {
  return value.trim().split("\n").slice(-lineCount).join("\n");
}

export function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export function openDirectoryDescriptor(path, errorPrefix = "ROLLBACK_CLEANUP_NOT_DIRECTORY") {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  const identity = fstatSync(descriptor, { bigint: true });
  if (!identity.isDirectory()) {
    closeSync(descriptor);
    throw new Error(errorPrefix + " path=" + path);
  }
  registerCustodyDescriptor(descriptor, realpathSync(path), identity);
  return descriptor;
}
