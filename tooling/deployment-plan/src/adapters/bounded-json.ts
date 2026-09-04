import { fail } from "../domain/model.ts";

export interface JsonLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly members: number;
  readonly arrayItems: number;
  readonly stringBytes: number;
}

function immutableLimits(limits: JsonLimits): Readonly<JsonLimits> {
  return Object.freeze(limits);
}

export const POLICY_JSON_LIMITS = immutableLimits({
  bytes: 64 * 1024,
  depth: 32,
  members: 256,
  arrayItems: 1_024,
  stringBytes: 16 * 1024,
});

// A genuine Forge 1.8.0 build-info was measured at 1,366,773 bytes, depth 26,
// 33,914 string bytes, 19 object members, and 31 array items. These ceilings
// provide finite format headroom without weakening policy/evidence parsing.
export const FORGE_BUILD_INFO_JSON_LIMITS = immutableLimits({
  bytes: 2 * 1024 * 1024,
  depth: 32,
  members: 64,
  arrayItems: 64,
  stringBytes: 64 * 1024,
});

// The selected contract artifact is smaller than complete build-info, while
// its bytecode strings legitimately exceed the policy string ceiling.
export const FORGE_ARTIFACT_JSON_LIMITS = immutableLimits({
  bytes: 512 * 1024,
  depth: 32,
  members: 128,
  arrayItems: 512,
  stringBytes: 128 * 1024,
});

export function parseBoundedJson(
  bytes: Uint8Array,
  limits: Readonly<JsonLimits>,
): unknown {
  if (bytes.byteLength > limits.bytes) {
    fail("JSON_LIMIT_BYTES", "JSON exceeds the byte limit");
  }
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("JSON_INVALID", "JSON is not strict UTF-8");
  }
  return new BoundedJsonParser(source, limits).parse();
}

class BoundedJsonParser {
  private index = 0;
  private readonly limits: Readonly<JsonLimits>;
  private readonly source: string;

  constructor(source: string, limits: Readonly<JsonLimits>) {
    this.source = source;
    this.limits = limits;
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
      if (depth >= this.limits.depth) {
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
      if (keys.size >= this.limits.members) {
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
      if (result.length >= this.limits.arrayItems) {
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
        if (Buffer.byteLength(encoded) > this.limits.stringBytes + 2) {
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
