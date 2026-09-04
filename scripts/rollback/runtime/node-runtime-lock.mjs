const SHA_256 = /^[a-f0-9]{64}$/u;

export function validateRuntimeNodeLock(lock, platform) {
  const node = lock?.tools?.node;
  const artifact = node?.platforms?.[platform];
  if (!validRuntimeNodeMetadata(lock, node)) {
    throw new Error("ROLLBACK_RUNTIME_LOCK_INVALID platform=" + platform);
  }
  const expectedVersionCheck = [{
    name: "node",
    path: "bin/node",
    args: ["--version"],
    pattern: "^v" + node.version.replaceAll(".", "\\.") + "$",
  }];
  const expectedArchiveName = "node-v" + node.version + "-linux-x64.tar.xz";
  const expectedFileHashes = artifact?.expectedFileSha256;
  if (!validRuntimeArtifactLocation(node, artifact, expectedArchiveName)
    || !validRuntimeArtifactHashes(artifact, expectedFileHashes)
    || JSON.stringify(artifact.versionChecks) !== JSON.stringify(expectedVersionCheck)) {
    throw new Error("ROLLBACK_RUNTIME_LOCK_INVALID platform=" + platform);
  }
  return { node, artifact, executableSha256: expectedFileHashes["bin/node"] };
}

function validRuntimeNodeMetadata(lock, node) {
  return lock?.schemaVersion === 2
    && node?.scope === "genesis-core"
    && typeof node.version === "string"
    && /^\d+\.\d+\.\d+$/u.test(node.version);
}

function validRuntimeArtifactLocation(node, artifact, expectedArchiveName) {
  return artifact?.archive === "tar.xz"
    && artifact.archiveName === expectedArchiveName
    && artifact.installDirectory === "node-v" + node.version + "-linux-x64"
    && artifact.url === "https://nodejs.org/dist/v" + node.version + "/" + expectedArchiveName
    && artifact.checksumSource
      === "https://nodejs.org/dist/v" + node.version + "/SHASUMS256.txt";
}

function validRuntimeArtifactHashes(artifact, expectedFileHashes) {
  return SHA_256.test(artifact.sha256 ?? "")
    && JSON.stringify(artifact.expectedFiles) === JSON.stringify(["bin/node"])
    && expectedFileHashes !== null
    && typeof expectedFileHashes === "object"
    && !Array.isArray(expectedFileHashes)
    && JSON.stringify(Object.keys(expectedFileHashes)) === JSON.stringify(["bin/node"])
    && SHA_256.test(expectedFileHashes["bin/node"] ?? "");
}
