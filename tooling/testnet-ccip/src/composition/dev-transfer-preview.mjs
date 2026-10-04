import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readPreviewInput } from '../adapters/dev-transfer-preview-input.mjs';
import { readPreviewFile, publishPreview, reopenPreview, previewPorts } from '../adapters/dev-transfer-preview-store.mjs';
import { prepareDevTransferPreview, assertForwardEncodingInput } from '../application/dev-transfer-preview.mjs';
import { loadForwardPreviewEncoding, loadBidirectionalPreviewEncoding } from '../adapters/dev-transfer-preview-provider.mjs';

const localPath = path => {
  if (!path || path.length > 4096 || path.includes('://') || resolve(path) !== path) {throw new Error('Bounded absolute local provider path required (including reverse input paths)');}
  return path;
};
export async function runDevTransferPreview(args) {
  const flags = Object.create(null), allowed = ['--input', '--output', '--reverse-input', '--provider-root', '--provider-archives', '--reopen'];
  if (args.length % 2) {throw new Error('Explicit local flag/path pairs required');}
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || Object.hasOwn(flags, args[i]) || !args[i + 1]) {throw new Error('Unknown or duplicate preview flag');}
    flags[args[i]] = args[i + 1];
  }
  const hasProvider = Object.hasOwn(flags, '--provider-root');
  if (hasProvider !== Object.hasOwn(flags, '--provider-archives')) {throw new Error('Use --input <local-json> --output <new-directory> with both explicit local provider paths');}
  const provider = () => ({ root: localPath(flags['--provider-root']), archives: localPath(flags['--provider-archives']) });
  if (flags['--reopen']) {
    if (flags['--input'] || flags['--output'] || flags['--reverse-input']) {throw new Error('Reopen takes only a directory and optional provider paths');}
    try {return await reopenPreview(flags['--reopen']);}
    catch (error) {
      if (!hasProvider || !error.message.startsWith('Reverse encoding prerequisite:')) {throw error;}
      const encoding = await loadBidirectionalPreviewEncoding(provider());
      return reopenPreview(flags['--reopen'], encoding);
    }
  }
  if (!flags['--input'] || !flags['--output']) {throw new Error('Use --input <local-json> --output <new-directory>, optional --reverse-input <absolute-local-json> and --provider-root/--provider-archives, or --reopen <directory>');}
  const reverseText = flags['--reverse-input'] ? (await readPreviewFile(localPath(flags['--reverse-input']))).toString() : undefined;
  const input = readPreviewInput((await readPreviewFile(flags['--input'])).toString(), reverseText);
  const prepared = prepareDevTransferPreview(input, previewPorts);
  if (!hasProvider) {return publishPreview(prepared, flags['--output']);}
  assertForwardEncodingInput(prepared.plan); // Known budget lower bounds precede any candidate evaluation.
  const encoding = input.reverseCall ? await loadBidirectionalPreviewEncoding(provider())
    : { forwardEncoding: await loadForwardPreviewEncoding(provider()) };
  return publishPreview(prepareDevTransferPreview(input, { ...previewPorts, ...encoding }), flags['--output'], encoding);
}
export function completeDevUnsignedEncoding(result) {
  return result.plan.evidenceClass === 'fixture-only' && result.facts.currentReadiness === null &&
    result.plan.legs.forward.callPlan?.sendAvailable === true && result.plan.legs.reverse.callPlan?.sendAvailable === true &&
    Object.values(result.plan.legs).every(leg => !leg.conflicts.length && !leg.prerequisites.length);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDevTransferPreview(process.argv.slice(2));
    console.log(JSON.stringify({ status: result.status, evidenceClass: result.evidenceClass, planHash: result.planHash,
      routeHash: result.routeHash, paths: result.paths, unsignedAvailable: result.plan.legs.forward.unsignedAvailable, broadcastAllowed: false,
      ...(result.plan.input.reverseCall ? { reverseUnsignedAvailable: result.plan.legs.reverse.unsignedAvailable, qualification: completeDevUnsignedEncoding(result) ? 'DEV-unsigned-local-encoding-only' : 'prerequisites' } : {}),
      ...(result.plan.legs.forward.callPlan ? { forwardAvailability: result.plan.legs.forward.callPlan.availability } : {}) }));
    process.exitCode = completeDevUnsignedEncoding(result) ? 0 : 2;
  } catch (error) {
    console.error('DEV_PREVIEW_REJECTED: ' + (error instanceof Error ? error.message : 'invalid input')); process.exitCode = error.code === 'ENOENT' || error.message.startsWith('Reverse encoding prerequisite:') ? 2 : 1;
  }
}
