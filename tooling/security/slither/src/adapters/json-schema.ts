import { readFile } from "node:fs/promises";
import { SlitherGateError } from "../domain/model.ts";

type JsonObject = Record<string, unknown>;

interface ValidationContext {
  readonly root: unknown;
  readonly path: string;
  readonly errors: string[];
}

export async function assertSerializedAgainstSchema(
  serialized: string,
  schemaPath: string,
): Promise<void> {
  let value: unknown;
  let schema: unknown;
  try {
    value = parseJsonWithoutDuplicateKeys(serialized);
    schema = parseJsonWithoutDuplicateKeys(await readFile(schemaPath, "utf8"));
  } catch {
    throw new SlitherGateError("EVIDENCE_SCHEMA_INVALID", "evidence or its exact schema is malformed JSON");
  }
  const errors: string[] = [];
  validate(value, schema, { root: schema, path: "$", errors });
  if (errors.length > 0) {
    throw new SlitherGateError("EVIDENCE_SCHEMA_INVALID", errors.slice(0, 5).join("; "));
  }
}

/** JSON.parse silently accepts duplicate keys. Evidence and policy inputs must not. */
export function parseJsonWithoutDuplicateKeys(serialized: string): unknown {
  let offset = 0;
  const whitespace = (): void => { while (/\s/u.test(serialized[offset] ?? "")) {offset += 1;} };
  const stringToken = (): string => {
    if (serialized[offset] !== '"') {throw new Error("expected JSON string");}
    const start = offset++;
    while (offset < serialized.length) {
      const character = serialized[offset++]!;
      if (character === '"') {return JSON.parse(serialized.slice(start, offset)) as string;}
      if (character === "\\") {offset += 1;}
      else if (character.charCodeAt(0) < 0x20) {throw new Error("invalid JSON string");}
    }
    throw new Error("unterminated JSON string");
  };
  const value = (): void => {
    whitespace();
    const character = serialized[offset];
    if (character === '"') {stringToken(); return;}
    if (character === "{") {
      offset += 1; whitespace();
      const keys = new Set<string>();
      if (serialized[offset] === "}") {offset += 1; return;}
      while (true) {
        whitespace(); const key = stringToken();
        if (keys.has(key)) {throw new Error(`duplicate JSON key: ${key}`);} keys.add(key);
        whitespace(); if (serialized[offset++] !== ":") {throw new Error("expected colon");}
        value(); whitespace();
        const delimiter = serialized[offset++];
        if (delimiter === "}") {return;}
        if (delimiter !== ",") {throw new Error("expected object delimiter");}
      }
    }
    if (character === "[") {
      offset += 1; whitespace();
      if (serialized[offset] === "]") {offset += 1; return;}
      while (true) {
        value(); whitespace();
        const delimiter = serialized[offset++];
        if (delimiter === "]") {return;}
        if (delimiter !== ",") {throw new Error("expected array delimiter");}
      }
    }
    const remainder = serialized.slice(offset);
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(remainder)?.[0];
    if (!token) {throw new Error("invalid JSON value");}
    offset += token.length;
  };
  value(); whitespace();
  if (offset !== serialized.length) {throw new Error("trailing JSON data");}
  return JSON.parse(serialized) as unknown;
}

function validate(value: unknown, rawSchema: unknown, context: ValidationContext): void {
  if (!isObject(rawSchema)) {context.errors.push(`${context.path}: schema node is not an object`); return;}
  const schema = resolve(rawSchema, context);
  if (!schema) {return;}
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => schemaMatches(value, candidate, context.root)).length;
    if (matches !== 1) {context.errors.push(`${context.path}: expected exactly one variant`); return;}
  }
  if (!validateCommonKeywords(value, schema, context)) {return;}
  validateString(value, schema, context);
  validateNumber(value, schema, context);
  validateArray(value, schema, context);
  validateObject(value, schema, context);
  validateForbiddenValue(value, schema, context);
}

function validateCommonKeywords(value: unknown, schema: JsonObject, context: ValidationContext): boolean {
  if ("const" in schema && !equal(value, schema.const)) {context.errors.push(`${context.path}: const mismatch`);}
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(value, item))) {context.errors.push(`${context.path}: enum mismatch`);}
  if (typeof schema.type === "string" && !hasType(value, schema.type)) {
    context.errors.push(`${context.path}: expected ${schema.type}`);
    return false;
  }
  return true;
}

function validateString(value: unknown, schema: JsonObject, context: ValidationContext): void {
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {context.errors.push(`${context.path}: pattern mismatch`);}
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {context.errors.push(`${context.path}: too short`);}
    if (schema.format === "date-time" && !validDateTime(value)) {context.errors.push(`${context.path}: invalid date-time`);}
  }
}

function validDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/u.exec(value);
  if (!match) {return false;}
  const normalized = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] ?? "000"}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === normalized;
}

function schemaMatches(value: unknown, schema: unknown, root: unknown): boolean {
  const errors: string[] = [];
  validate(value, schema, { root, path: "$", errors });
  return errors.length === 0;
}

function validateNumber(value: unknown, schema: JsonObject, context: ValidationContext): void {
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {context.errors.push(`${context.path}: below minimum`);}
}

function validateArray(value: unknown, schema: JsonObject, context: ValidationContext): void {
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {context.errors.push(`${context.path}: too few items`);}
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {context.errors.push(`${context.path}: too many items`);}
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {context.errors.push(`${context.path}: duplicate items`);}
    if (schema.items !== undefined) {value.forEach((item, index) => validate(item, schema.items, childContext(context, `[${index}]`)));}
  }
}

function validateObject(value: unknown, schema: JsonObject, context: ValidationContext): void {
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    validateRequiredProperties(value, schema.required, context);
    validateAdditionalProperties(value, properties, schema.additionalProperties, context);
    validateProperties(value, properties, context);
  }
}

function validateRequiredProperties(value: JsonObject, rawRequired: unknown, context: ValidationContext): void {
  const required = Array.isArray(rawRequired) ? rawRequired : [];
  for (const key of required) {
    if (typeof key === "string" && !(key in value)) {context.errors.push(`${context.path}: missing ${key}`);}
  }
}

function validateAdditionalProperties(value: JsonObject, properties: JsonObject, additionalProperties: unknown, context: ValidationContext): void {
  if (additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {context.errors.push(`${context.path}: unexpected ${key}`);}
    }
  }
}

function validateProperties(value: JsonObject, properties: JsonObject, context: ValidationContext): void {
  for (const [key, childSchema] of Object.entries(properties)) {
    if (key in value) {validate(value[key], childSchema, childContext(context, `.${key}`));}
  }
}

function validateForbiddenValue(value: unknown, schema: JsonObject, context: ValidationContext): void {
  if (isObject(schema.not) && matchesPatternOnly(value, schema.not)) {context.errors.push(`${context.path}: forbidden value`);}
}

function childContext(context: ValidationContext, suffix: string): ValidationContext {
  return { ...context, path: `${context.path}${suffix}` };
}

function resolve(schema: JsonObject, context: ValidationContext): JsonObject | undefined {
  if (typeof schema.$ref !== "string") {return schema;}
  if (!schema.$ref.startsWith("#/") || !isObject(context.root)) {context.errors.push(`${context.path}: unsupported ref`); return undefined;}
  let current: unknown = context.root;
  for (const part of schema.$ref.slice(2).split("/")) {
    if (!isObject(current) || !(part in current)) {context.errors.push(`${context.path}: missing ref`); return undefined;}
    current = current[part];
  }
  return isObject(current) ? current : undefined;
}

const isObject = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
function hasType(value: unknown, type: string): boolean {
  if (type === "object") {return isObject(value);}
  if (type === "array") {return Array.isArray(value);}
  if (type === "integer") {return Number.isSafeInteger(value);}
  return typeof value === type;
}
function matchesPatternOnly(value: unknown, schema: JsonObject): boolean {
  return typeof value === "string" && typeof schema.pattern === "string" && new RegExp(schema.pattern, "u").test(value);
}
