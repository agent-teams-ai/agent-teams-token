export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** RFC 8785 for the feature's JSON data model (finite safe integers only). */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {return JSON.stringify(value);}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new TypeError("canonical JSON only accepts safe integers; wide integers must be strings");}
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {return `[${value.map(canonicalJson).join(",")}]`;}
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).toSorted().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}
