import { createHash } from "node:crypto";
export function sha256(bytes: Uint8Array): `0x${string}` { return `0x${createHash("sha256").update(bytes).digest("hex")}`; }
