import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readPreviewInput } from '../adapters/dev-transfer-preview-input.mjs';
import { readPreviewFile, publishPreview, reopenPreview, previewPorts } from '../adapters/dev-transfer-preview-store.mjs';
import { prepareDevTransferPreview, assertForwardEncodingInput } from '../application/dev-transfer-preview.mjs';
import { loadForwardPreviewEncoding } from '../adapters/dev-transfer-preview-provider.mjs';

export async function runDevTransferPreview(args) {
  if (args.length === 2 && args[0] === '--reopen') {return reopenPreview(args[1]);}
  const encoding = args.length === 8 && args[4] === '--provider-root' && args[6] === '--provider-archives';
  if ((!encoding && args.length !== 4) || args[0] !== '--input' || args[2] !== '--output') {throw new Error('Use --input <local-json> --output <new-directory> [--provider-root <absolute-local-directory> --provider-archives <absolute-local-directory>], or --reopen <directory>');}
  const input = readPreviewInput((await readPreviewFile(args[1])).toString());
  const prepared = prepareDevTransferPreview(input, previewPorts);
  if (!encoding) {return publishPreview(prepared, args[3]);}
  assertForwardEncodingInput(prepared.plan);
  for (const path of [args[5], args[7]]) {
    if (!path || path.length > 4096 || path.includes('://') || resolve(path) !== path) {throw new Error('Bounded absolute local provider path required');}
  }
  const forwardEncoding = await loadForwardPreviewEncoding({ root: args[5], archives: args[7] });
  return publishPreview(prepareDevTransferPreview(input, { ...previewPorts, forwardEncoding }), args[3]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDevTransferPreview(process.argv.slice(2));
    console.log(JSON.stringify({ status: result.status, evidenceClass: result.evidenceClass, planHash: result.planHash,
      routeHash: result.routeHash, paths: result.paths, unsignedAvailable: result.plan.legs.forward.unsignedAvailable, broadcastAllowed: false,
      ...(result.plan.legs.forward.callPlan ? { forwardAvailability: result.plan.legs.forward.callPlan.availability } : {}) }));
    process.exitCode = 2; // Persisted diagnostic is complete; full unsigned PR1 acceptance remains open.
  } catch (error) {
    console.error('DEV_PREVIEW_REJECTED: ' + (error instanceof Error ? error.message : 'invalid input')); process.exitCode = 1;
  }
}
