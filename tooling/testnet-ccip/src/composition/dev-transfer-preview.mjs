import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readPreviewInput } from '../adapters/dev-transfer-preview-input.mjs';
import { readPreviewFile, publishPreview, reopenPreview, previewPorts } from '../adapters/dev-transfer-preview-store.mjs';
import { prepareDevTransferPreview } from '../application/dev-transfer-preview.mjs';

export async function runDevTransferPreview(args) {
  if (args.length === 2 && args[0] === '--reopen') {return reopenPreview(args[1]);}
  if (args.length !== 4 || args[0] !== '--input' || args[2] !== '--output') {throw new Error('Use --input <local-json> --output <new-directory>, or --reopen <directory>');}
  const input = readPreviewInput((await readPreviewFile(args[1])).toString());
  return publishPreview(prepareDevTransferPreview(input, previewPorts), args[3]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDevTransferPreview(process.argv.slice(2));
    console.log(JSON.stringify({ status: result.status, evidenceClass: result.evidenceClass, planHash: result.planHash,
      routeHash: result.routeHash, paths: result.paths, unsignedAvailable: false, broadcastAllowed: false }));
    process.exitCode = 2; // Persisted diagnostic is complete; full unsigned PR1 acceptance remains open.
  } catch (error) {
    console.error('DEV_PREVIEW_REJECTED: ' + (error instanceof Error ? error.message : 'invalid input')); process.exitCode = 1;
  }
}
