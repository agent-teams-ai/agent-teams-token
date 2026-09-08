import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeConstructorArguments, reconstructCreationInput } from "../constructor.ts";
import { sha256HexBytes } from "../crypto.ts";
import type { ConstructorInputs } from "../model.ts";

const inputs: ConstructorInputs = {
  schemaVersion: 1,
  initialSupplyBaseUnits: "10",
  allocations: [{
    idBytes32: `0x${"11".repeat(32)}`,
    recipient: "0x2222222222222222222222222222222222222222",
    amountBaseUnits: "10",
  }],
};

const build = {
  output: {
    contracts: {
      "src/features/token-genesis/AGTMAIToken.sol": {
        AGTMAIToken: { evm: { bytecode: { object: "6000", linkReferences: {} } } },
      },
    },
  },
};

test("shared constructor encoder produces exact ABI words and build-info creation input", () => {
  const expectedArguments = `0x${[
    word("10"), word("64"), word("1"), "11".repeat(32),
    "22".repeat(20).padStart(64, "0"), word("10"),
  ].join("")}`;
  assert.equal(encodeConstructorArguments(inputs), expectedArguments);
  assert.equal(
    reconstructCreationInput(build, { bytecode: { object: "0x6000" } }, inputs),
    `0x6000${expectedArguments.slice(2)}`,
  );
});

test("creation-input SHA-256 hashes decoded bytes with the cross-tool golden vector", () => {
  assert.equal(
    sha256HexBytes("0x01020304"),
    "0x9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
  );
});

test("creation reconstruction rejects artifact bytecode differing from build-info", () => {
  assert.throws(
    () => reconstructCreationInput(build, { bytecode: { object: "0x6001" } }, inputs),
    (cause: unknown) => cause instanceof Error && "code" in cause
      && cause.code === "VERIFY_ARTIFACT_BUILD_CREATION_MISMATCH",
  );
});

function word(value: string): string { return BigInt(value).toString(16).padStart(64, "0"); }
