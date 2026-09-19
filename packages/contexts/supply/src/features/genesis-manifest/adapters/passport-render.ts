import { canonicalJson } from "../application/canonical.js";
import type { JsonValue } from "../application/canonical.js";
import type { TokenPassport } from "../application/passport.js";
export const renderPassport = (passport: TokenPassport): Uint8Array => new TextEncoder().encode(passport.markdown);
export const renderAuthorityRegistry = (passport: TokenPassport): Uint8Array => new TextEncoder().encode(`${canonicalJson(passport.authorityRegistry as unknown as JsonValue)}\n`);
