export const UINT256_MAX = (1n << 256n) - 1n;
export const LOCAL_CHAIN_ID = "31337";

export class DeploymentPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DeploymentPlanError";
    this.code = code;
  }
}

export interface CostInput {
  readonly gasEstimate: bigint;
  readonly bufferBps: bigint;
  readonly baseFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxFeePerGas: bigint;
  readonly value: bigint;
  readonly blockGasLimit: bigint;
  readonly maximumWorstCaseWei: bigint;
}

export interface CostResult {
  readonly gasLimit: bigint;
  readonly effectiveFee: bigint;
  readonly estimatedWei: bigint;
  readonly worstCaseWei: bigint;
}

export function fail(code: string, message: string): never {
  throw new DeploymentPlanError(code, message);
}

export function parseUint(value: unknown, field: string, allowZero = true): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    fail("INVALID_DECIMAL", `${field} must be a canonical decimal string`);
  }
  if (value.length > 78) {
    fail("DECIMAL_TOO_LONG", `${field} exceeds the maximum decimal length`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > UINT256_MAX) {
    fail("UINT256_RANGE", `${field} is outside uint256`);
  }
  return parsed;
}

export function checkedAdd(left: bigint, right: bigint, field: string): bigint {
  const result = left + right;
  if (left < 0n || right < 0n || result > UINT256_MAX) {
    fail("UINT256_OVERFLOW", `${field} overflow`);
  }
  return result;
}

export function checkedMul(left: bigint, right: bigint, field: string): bigint {
  const result = left * right;
  if (left < 0n || right < 0n || result > UINT256_MAX) {
    fail("UINT256_OVERFLOW", `${field} overflow`);
  }
  return result;
}

export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (numerator < 0n || denominator <= 0n) {
    fail("INVALID_ARITHMETIC", "invalid ceilDiv operands");
  }
  return numerator === 0n ? 0n : ((numerator - 1n) / denominator) + 1n;
}

function validateCostInput(input: CostInput): void {
  for (const [name, value] of Object.entries(input)) {
    if (value < 0n || value > UINT256_MAX) {
      fail("UINT256_RANGE", `${name} is outside uint256`);
    }
  }
  if (input.gasEstimate === 0n) {
    fail("GAS_ESTIMATE_ZERO", "gas estimate must be positive");
  }
  if (input.bufferBps > 100_000n) {
    fail("GAS_BUFFER_ABSURD", "gas buffer exceeds 1000%");
  }
  if (input.maxFeePerGas < input.baseFeePerGas) {
    fail("MAX_FEE_BELOW_BASE", "max fee is below base fee");
  }
  if (input.maxPriorityFeePerGas > input.maxFeePerGas) {
    fail("PRIORITY_ABOVE_MAX", "priority fee exceeds max fee");
  }
}

export function calculateCosts(input: CostInput): CostResult {
  validateCostInput(input);
  const bufferFactor = checkedAdd(10_000n, input.bufferBps, "buffer factor");
  const bufferedGas = checkedMul(input.gasEstimate, bufferFactor, "buffered gas");
  const gasLimit = ceilDiv(bufferedGas, 10_000n);
  if (gasLimit < input.gasEstimate) {
    fail("GAS_LIMIT_BELOW_ESTIMATE", "gas limit is below estimate");
  }
  if (gasLimit > input.blockGasLimit) {
    fail("GAS_LIMIT_ABOVE_BLOCK", "gas limit exceeds block gas limit");
  }
  const basePlusPriority = checkedAdd(
    input.baseFeePerGas,
    input.maxPriorityFeePerGas,
    "effective fee",
  );
  const effectiveFee = input.maxFeePerGas < basePlusPriority
    ? input.maxFeePerGas
    : basePlusPriority;
  const estimatedWei = checkedAdd(checkedMul(input.gasEstimate, effectiveFee, "estimated wei"), input.value, "estimated wei");
  const worstCaseWei = checkedAdd(checkedMul(gasLimit, input.maxFeePerGas, "worst-case wei"), input.value, "worst-case wei");
  if (worstCaseWei > input.maximumWorstCaseWei) {
    fail("COST_CAP_EXCEEDED", "worst-case wei exceeds test-only cap");
  }
  return { gasLimit, effectiveFee, estimatedWei, worstCaseWei };
}
