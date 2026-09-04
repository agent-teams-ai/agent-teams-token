const SHA256 = /^[a-f0-9]{64}$/u;
const COMPONENT = /^[a-zA-Z0-9.+_-]+$/u;
const PROVENANCE_KEYS = [
  "artifactSha256",
  "files",
  "inventorySha256",
  "platform",
  "schemaVersion",
  "tool",
  "version",
];

export const toolchainProvenanceFile = ".agtmai-toolchain-install.json";
export const toolchainProvenanceSchemaVersion = 2;

export function createToolchainProvenance(fields) {
  const provenance = {
    schemaVersion: toolchainProvenanceSchemaVersion,
    tool: fields.tool,
    version: fields.version,
    platform: fields.platform,
    artifactSha256: fields.artifactSha256,
    inventorySha256: fields.inventorySha256,
    files: fields.files,
  };
  validateToolchainProvenance(provenance, fields);
  return provenance;
}

export function serializeToolchainProvenance(fields) {
  return `${JSON.stringify(createToolchainProvenance(fields), null, 2)}\n`;
}

export function parseToolchainProvenance(bytes, expected = {}) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  if (Buffer.isBuffer(bytes) && !Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=utf8");
  }
  let provenance;
  try {
    provenance = JSON.parse(text);
  } catch (error) {
    throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=json", { cause: error });
  }
  validateToolchainProvenance(provenance, expected);
  return provenance;
}

export function validateToolchainProvenance(provenance, expected = {}) {
  validateProvenanceShape(provenance);
  validateProvenanceFields(provenance);
  validateFiles(provenance.files);
  validateExpectedProvenance(provenance, expected);
  return provenance;
}

function validateProvenanceShape(provenance) {
  if (provenance === null || typeof provenance !== "object" || Array.isArray(provenance)
    || JSON.stringify(Object.keys(provenance).toSorted()) !== JSON.stringify(PROVENANCE_KEYS)) {
    throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=shape");
  }
}

function validateProvenanceFields(provenance) {
  if (provenance.schemaVersion !== toolchainProvenanceSchemaVersion
    || !COMPONENT.test(provenance.tool ?? "")
    || !COMPONENT.test(provenance.version ?? "")
    || !COMPONENT.test(provenance.platform ?? "")
    || !SHA256.test(provenance.artifactSha256 ?? "")
    || !SHA256.test(provenance.inventorySha256 ?? "")) {
    throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=field");
  }
}

function validateExpectedProvenance(provenance, expected) {
  for (const key of ["tool", "version", "platform", "artifactSha256", "inventorySha256"]) {
    if (expected[key] !== undefined && provenance[key] !== expected[key]) {
      throw new Error(`TOOLCHAIN_PROVENANCE_MISMATCH field=${key}`);
    }
  }
  if (expected.files !== undefined
    && JSON.stringify(provenance.files) !== JSON.stringify(expected.files)) {
    throw new Error("TOOLCHAIN_PROVENANCE_MISMATCH field=files");
  }
}

function validateFiles(files) {
  if (files === null || typeof files !== "object" || Array.isArray(files)
    || Object.keys(files).length === 0) {
    throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=files");
  }
  for (const [path, digest] of Object.entries(files)) {
    if (path.length === 0 || path.startsWith("/") || path.includes("\\")
      || path.split("/").some((component) => component === "" || component === "." || component === "..")
      || !SHA256.test(digest)) {
      throw new Error("TOOLCHAIN_PROVENANCE_INVALID reason=files");
    }
  }
}
