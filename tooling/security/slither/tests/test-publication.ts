import { ExclusiveDirectoryPublication } from "../src/adapters/evidence.ts";
/** Explicit test-only publication capability; production composition never imports this module. */
export const testPublication = (): ExclusiveDirectoryPublication => new ExclusiveDirectoryPublication();
