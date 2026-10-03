// Separate opt-in real payload admission. Missing inputs fail; this is never a skipped default test.
import { resolve } from 'node:path';
import { admitPreviewProviders } from '../src/adapters/dev-transfer-preview-provider.mjs';
import { readPreviewFile } from '../src/adapters/dev-transfer-preview-store.mjs';
import { parsePreviewJson } from '../src/adapters/dev-transfer-preview-input.mjs';
const [root, mapPath, ...extra] = process.argv.slice(2);
if (!root || !mapPath || extra.length) { throw new Error('Require reviewed provider root and explicit public lock-path-to-tarball JSON map'); }
const map = parsePreviewJson((await readPreviewFile(mapPath)).toString());
const result = await admitPreviewProviders({ root, tarballSource: async rel => {
  if (typeof map[rel] !== 'string') { throw new Error('Missing retained archive for ' + rel); }
  return readPreviewFile(resolve(map[rel]), 33554432);
} });
console.log(JSON.stringify(result));
