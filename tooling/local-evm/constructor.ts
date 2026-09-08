import { strip0x } from "./crypto.ts";
import { LocalEvmError, type ConstructorInputs } from "./model.ts";

const CONTRACT_SOURCE = "src/features/token-genesis/AGTMAIToken.sol";
const CONTRACT_NAME = "AGTMAIToken";

export function encodeConstructorArguments(value: ConstructorInputs): `0x${string}` {
  const words = [word(value.initialSupplyBaseUnits), word("64"), word(String(value.allocations.length))];
  for (const allocation of value.allocations) {
    words.push(strip0x(allocation.idBytes32), strip0x(allocation.recipient).padStart(64, "0"), word(allocation.amountBaseUnits));
  }
  return `0x${words.join("")}`;
}

export function reconstructCreationInput(
  build: Record<string, unknown>,
  artifact: Record<string, unknown>,
  constructorInputs: ConstructorInputs,
): `0x${string}` {
  const output = object(build.output, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const contracts = object(output.contracts, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const source = object(contracts[CONTRACT_SOURCE], "VERIFY_BUILD_CONTRACT_MISSING");
  const contract = object(source[CONTRACT_NAME], "VERIFY_BUILD_CONTRACT_MISSING");
  const evm = object(contract.evm, "VERIFY_BUILD_INFO_SHAPE_INVALID");
  const bytecode = object(evm.bytecode, "VERIFY_BUILD_CREATION_BYTECODE_MISSING");
  if (hasReferences(bytecode.linkReferences)) {
    throw new LocalEvmError("VERIFY_CREATION_LINK_REFERENCES_UNSUPPORTED", "linked creation bytecode cannot be proven");
  }
  const buildObject = bytecode.object;
  if (typeof buildObject !== "string" || !/^[0-9a-f]+$/u.test(buildObject) || buildObject.length % 2 !== 0) {
    throw new LocalEvmError("VERIFY_BUILD_CREATION_BYTECODE_INVALID", "build-info creation bytecode is malformed");
  }
  const artifactBytecode = object(artifact.bytecode, "VERIFY_ARTIFACT_CREATION_BYTECODE_MISSING");
  const artifactObject = artifactBytecode.object;
  if (artifactObject !== buildObject && artifactObject !== `0x${buildObject}`) {
    throw new LocalEvmError("VERIFY_ARTIFACT_BUILD_CREATION_MISMATCH", "artifact creation bytecode differs from build-info creation bytecode");
  }
  return `0x${buildObject}${strip0x(encodeConstructorArguments(constructorInputs))}`;
}

function word(value: string): string {
  return BigInt(value).toString(16).padStart(64, "0");
}

function object(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {throw new LocalEvmError(code, "expected an object");}
  return value as Record<string, unknown>;
}

function hasReferences(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {return false;}
  return Object.values(value).some((contracts) => contracts !== null && typeof contracts === "object" && !Array.isArray(contracts)
    && Object.values(contracts).some((entries) => Array.isArray(entries) && entries.length > 0));
}
