export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** RFC 8785 for the feature's JSON data model (finite safe integers only). */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {return JSON.stringify(value);}
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {throw new TypeError("canonical JSON only accepts safe integers; wide integers must be strings");}
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) { throw new TypeError("canonical JSON rejects sparse or extended arrays"); }
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) { throw new TypeError("canonical JSON rejects sparse arrays"); }
    }
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value !== "object" || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError("canonical JSON requires plain JSON values; wide integers must be strings");
  }
  const object = value as { readonly [key: string]: JsonValue };
  return `{${Object.keys(object).toSorted().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(",")}}`;
}
