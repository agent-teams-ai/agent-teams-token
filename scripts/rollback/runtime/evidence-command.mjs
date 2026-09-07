import { closeDescriptorOnce } from "./descriptor-close.mjs";

const EVIDENCE_ENVIRONMENT_KEYS = [
  "AGTMAI_ROLLBACK_EVIDENCE_DIRECTORY",
  "AGTMAI_ROLLBACK_TMPDIR",
  "AGTMAI_ANVIL_BINARY",
  "AGTMAI_FORGE_BINARY",
  "AGTMAI_SOLANA_REAL_TESTS_REQUIRED",
  "AGTMAI_SOLC_BINARY",
  "CI",
  "FOUNDRY_PROFILE",
  "GITHUB_SHA",
  "HOME",
  "LANG",
  "LC_ALL",
  "PATH",
  "SLITHER_CANDIDATE_SHA",
  "SLITHER_DOCKER_PATH",
  "SLITHER_EVIDENCE_DIRECTORY",
  "SLITHER_FORGE_PATH",
  "SLITHER_REPOSITORY_ROOT",
  "SLITHER_SOLC_PATH",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
];

export function selectedEnvironment(environment) {
  return Object.fromEntries(
    EVIDENCE_ENVIRONMENT_KEYS
      .filter((key) => environment[key] !== undefined)
      .map((key) => [key, String(environment[key])]),
  );
}

export function closeCommandLogDescriptors(descriptors) {
  const failures = [];
  for (const descriptor of descriptors) {
    if (!Number.isInteger(descriptor)) {
      continue;
    }
    try {
      closeDescriptorOnce(descriptor);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}
