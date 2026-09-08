import { createHash } from "node:crypto";
import { compareUtf8 } from "./cleanup-tree.mjs";

export function cleanupSnapshotSha256(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(snapshot.entries.map(cleanupSnapshotEntry)))
    .digest("hex");
}

function cleanupSnapshotEntry(entry) {
  return {
    name: entry.name,
    kind: entry.kind,
    fingerprint: entry.fingerprint,
    children: entry.children.map(cleanupSnapshotEntry),
  };
}


export function cleanupRemovalResult(handle, report, limits) {
  report.sort((left, right) => compareUtf8(left.path, right.path));
  return {
    schemaVersion: 2,
    result: "contents-removed",
    device: handle.device,
    inode: handle.inode,
    allowedEntries: [...handle.allowedEntries],
    limits: {
      maxDepth: limits.maxDepth,
      maxEntries: limits.maxEntries,
      maxRelativeBytes: limits.maxRelativeBytes,
    },
    removedEntryCount: report.length,
    removedEntries: report,
  };
}
