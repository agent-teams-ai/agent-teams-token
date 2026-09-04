export const TOOLCHAIN_JSON_LIMITS = Object.freeze({
  bytes: 64 * 1024,
  depth: 32,
  members: 256,
  arrayItems: 1_024,
  stringBytes: 16 * 1024,
});

export function parseToolchainJson(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > TOOLCHAIN_JSON_LIMITS.bytes) {
    throw new Error("TOOLCHAIN_JSON_LIMIT_BYTES");
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("TOOLCHAIN_JSON_INVALID_UTF8");
  }
  return new ToolchainJsonParser(source).parse();
}

class ToolchainJsonParser {
  index = 0;
  constructor(source) {
    this.source = source;
  }
  parse() {
    const value = this.value(0);
    this.space();
    if (this.index !== this.source.length) {this.invalid();}
    return value;
  }
  value(depth) {
    this.space();
    const character = this.source[this.index];
    if (character === "{" || character === "[") {
      if (depth >= TOOLCHAIN_JSON_LIMITS.depth) {
        throw new Error("TOOLCHAIN_JSON_LIMIT_DEPTH");
      }
      return character === "{" ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (character === '"') {return this.string();}
    for (const [token, value] of [["true", true], ["false", false], ["null", null]]) {
      if (this.source.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    }
    return this.number();
  }
  number() {
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(this.source.slice(this.index));
    if (match === null) {return this.invalid();}
    this.index += match[0].length;
    const value = Number(match[0]);
    if (match[0] === "-0" || !Number.isSafeInteger(value)) {return this.invalid();}
    return value;
  }
  object(depth) {
    this.index += 1;
    const result = {};
    const keys = new Set();
    this.space();
    if (this.take("}")) {return result;}
    for (;;) {
      if (keys.size >= TOOLCHAIN_JSON_LIMITS.members) {
        throw new Error("TOOLCHAIN_JSON_LIMIT_MEMBERS");
      }
      this.space();
      if (this.source[this.index] !== '"') {this.invalid();}
      const key = this.string();
      if (keys.has(key)) {throw new Error(`TOOLCHAIN_JSON_DUPLICATE_KEY key=${key}`);}
      keys.add(key);
      this.space();
      if (!this.take(":")) {this.invalid();}
      Object.defineProperty(result, key, {
        value: this.value(depth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.space();
      if (this.take("}")) {return result;}
      if (!this.take(",")) {this.invalid();}
    }
  }
  array(depth) {
    this.index += 1;
    const result = [];
    this.space();
    if (this.take("]")) {return result;}
    for (;;) {
      if (result.length >= TOOLCHAIN_JSON_LIMITS.arrayItems) {
        throw new Error("TOOLCHAIN_JSON_LIMIT_ARRAY");
      }
      result.push(this.value(depth));
      this.space();
      if (this.take("]")) {return result;}
      if (!this.take(",")) {this.invalid();}
    }
  }
  string() {
    const start = this.index++;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"') {
        const encoded = this.source.slice(start, this.index);
        if (Buffer.byteLength(encoded) > TOOLCHAIN_JSON_LIMITS.stringBytes + 2) {
          throw new Error("TOOLCHAIN_JSON_LIMIT_STRING");
        }
        try {return JSON.parse(encoded);}
        catch {return this.invalid();}
      }
      if (character === "\\") {this.index += 1;}
      else if (character.charCodeAt(0) < 0x20) {this.invalid();}
    }
    return this.invalid();
  }
  space() {
    while ([" ", "\t", "\r", "\n"].includes(this.source[this.index])) {this.index += 1;}
  }
  take(character) {
    if (this.source[this.index] !== character) {return false;}
    this.index += 1;
    return true;
  }
  invalid() {
    throw new Error(`TOOLCHAIN_JSON_INVALID offset=${this.index}`);
  }
}
