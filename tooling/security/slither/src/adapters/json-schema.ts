import { readFile } from "node:fs/promises";
import { SlitherGateError } from "../domain/model.ts";

type JsonObject = Record<string, unknown>;

export async function assertSerializedAgainstSchema(
  serialized: string,
  schemaPath: string,
): Promise<void> {
  let value: unknown;
  let schema: unknown;
  try {
    value = JSON.parse(serialized);
    schema = JSON.parse(await readFile(schemaPath, "utf8"));
  } catch {
    throw new SlitherGateError("EVIDENCE_SCHEMA_INVALID", "evidence or its exact schema is malformed JSON");
  }
  const errors: string[] = [];
  validate(value, schema, schema, "$", errors);
  if (errors.length > 0) {
    throw new SlitherGateError("EVIDENCE_SCHEMA_INVALID", errors.slice(0, 5).join("; "));
  }
}

function validate(value: unknown, rawSchema: unknown, root: unknown, path: string, errors: string[]): void {
  if (!isObject(rawSchema)) {errors.push(`${path}: schema node is not an object`); return;}
  const schema = resolve(rawSchema, root, errors, path);
  if (!schema) {return;}
  if ("const" in schema && !equal(value, schema.const)) {errors.push(`${path}: const mismatch`);}
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => equal(value, item))) {errors.push(`${path}: enum mismatch`);}
  if (typeof schema.type === "string" && !hasType(value, schema.type)) {errors.push(`${path}: expected ${schema.type}`); return;}
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) {errors.push(`${path}: pattern mismatch`);}
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {errors.push(`${path}: too short`);}
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {errors.push(`${path}: below minimum`);}
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {errors.push(`${path}: too few items`);}
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {errors.push(`${path}: too many items`);}
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) {errors.push(`${path}: duplicate items`);}
    if (schema.items !== undefined) {value.forEach((item, index) => validate(item, schema.items, root, `${path}[${index}]`, errors));}
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {if (typeof key === "string" && !(key in value)) {errors.push(`${path}: missing ${key}`);}}
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {if (!(key in properties)) {errors.push(`${path}: unexpected ${key}`);}}
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {validate(value[key], childSchema, root, `${path}.${key}`, errors);}
    }
  }
  if (isObject(schema.not) && matchesPatternOnly(value, schema.not)) {errors.push(`${path}: forbidden value`);}
}

function resolve(schema: JsonObject, root: unknown, errors: string[], path: string): JsonObject | undefined {
  if (typeof schema.$ref !== "string") {return schema;}
  if (!schema.$ref.startsWith("#/") || !isObject(root)) {errors.push(`${path}: unsupported ref`); return undefined;}
  let current: unknown = root;
  for (const part of schema.$ref.slice(2).split("/")) {
    if (!isObject(current) || !(part in current)) {errors.push(`${path}: missing ref`); return undefined;}
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
