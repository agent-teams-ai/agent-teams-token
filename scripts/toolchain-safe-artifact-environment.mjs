import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";

function invalidSafeArtifactEnvironment() {
  throw new Error("TOOLCHAIN_SAFE_ARTIFACT_ENV_INVALID");
}

export function validateSafeArtifactEnvironment(value) {
  if (value === undefined) {return;}
  if (value === null || typeof value !== "object"
    || JSON.stringify(Object.keys(value).toSorted()) !== JSON.stringify(["directory", "pinsSha256"])) {
    invalidSafeArtifactEnvironment();
  }
  const { directory, pinsSha256 } = value;
  if (typeof directory !== "string" || !isAbsolute(directory)
    || [...directory].some((character) => character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f)
    || typeof pinsSha256 !== "string" || !/^0x[a-f0-9]{64}$/u.test(pinsSha256)) {
    invalidSafeArtifactEnvironment();
  }
  let stat;
  try {stat = lstatSync(directory);}
  catch {invalidSafeArtifactEnvironment();}
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
    || (stat.mode & 0o022) !== 0) {
    invalidSafeArtifactEnvironment();
  }
  return { directory, pinsSha256 };
}
