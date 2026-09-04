import { fail } from "../domain/model.ts";

export const JSON_LIMITS = {
  bytes: 64 * 1024,
  depth: 32,
  members: 256,
  arrayItems: 1_024,
  stringBytes: 16 * 1024,
} as const;

export function parseBoundedJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength > JSON_LIMITS.bytes) {
    fail("JSON_LIMIT_BYTES", "JSON exceeds the byte limit");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("JSON_INVALID", "JSON is not strict UTF-8");
  }
  return new BoundedJsonParser(source).parse();
}

class BoundedJsonParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): unknown {
    const result = this.value(0);
    this.space();
    if (this.index !== this.source.length) {
      this.invalid();
    }
    return result;
  }

  private value(depth: number): unknown {
    this.space();
    const character = this.source[this.index];
    if (character === "{" || character === "[") {
      if (depth >= JSON_LIMITS.depth) {
        fail("JSON_LIMIT_DEPTH", "JSON exceeds the nesting depth limit");
      }
      return character === "{" ? this.object(depth + 1) : this.array(depth + 1);
    }
    if (character === '"') {
      return this.string();
    }
    for (const [token, value] of [["true", true], ["false", false], ["null", null]] as const) {
      if (this.source.startsWith(token, this.index)) {
        this.index += token.length;
        return value;
      }
    }
    return this.number();
  }

  private number(): number {
    const match = /^-?(?:0|[1-9][0-9]*)/u.exec(this.source.slice(this.index));
    if (match === null) {
      return this.invalid();
    }
    this.index += match[0].length;
    const parsed = Number(match[0]);
    if (match[0] === "-0" || !Number.isSafeInteger(parsed)) {
      return this.invalid();
    }
    return parsed;
  }

  private object(depth: number): Record<string, unknown> {
    this.index += 1;
    const result = Object.create(null) as Record<string, unknown>;
    const keys = new Set<string>();
    this.space();
    if (this.take("}")) {
      return result;
    }
    for (;;) {
      if (keys.size >= JSON_LIMITS.members) {
        fail("JSON_LIMIT_MEMBERS", "JSON object exceeds the member limit");
      }
      this.space();
      if (this.source[this.index] !== '"') {
        this.invalid();
      }
      const key = this.string();
      if (keys.has(key)) {
        fail("JSON_DUPLICATE_KEY", `duplicate JSON member: ${key}`);
      }
      keys.add(key);
      this.space();
      if (!this.take(":")) {
        this.invalid();
      }
      Object.defineProperty(result, key, {
        value: this.value(depth),
        enumerable: true,
        configurable: true,
        writable: true,
      });
      this.space();
      if (this.take("}")) {
        return result;
      }
      if (!this.take(",")) {
        this.invalid();
      }
    }
  }

  private array(depth: number): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.space();
    if (this.take("]")) {
      return result;
    }
    for (;;) {
      if (result.length >= JSON_LIMITS.arrayItems) {
        fail("JSON_LIMIT_ARRAY", "JSON array exceeds the item limit");
      }
      result.push(this.value(depth));
      this.space();
      if (this.take("]")) {
        return result;
      }
      if (!this.take(",")) {
        this.invalid();
      }
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index++];
      if (character === '"') {
        const encoded = this.source.slice(start, this.index);
        if (Buffer.byteLength(encoded) > JSON_LIMITS.stringBytes + 2) {
          fail("JSON_LIMIT_STRING", "JSON string exceeds the byte limit");
        }
        try {
          return JSON.parse(encoded) as string;
        } catch {
          return this.invalid();
        }
      }
      if (character === "\\") {
        this.index += 1;
      } else if (character.charCodeAt(0) < 0x20) {
        this.invalid();
      }
    }
    return this.invalid();
  }

  private space(): void {
    while (isJsonWhitespace(this.source[this.index])) {
      this.index += 1;
    }
  }

  private take(character: string): boolean {
    if (this.source[this.index] !== character) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private invalid(): never {
    fail("JSON_INVALID", `malformed JSON at byte ${this.index}`);
  }
}

function isJsonWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t" || character === "\r" || character === "\n";
}
