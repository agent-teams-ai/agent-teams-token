import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadReportInput, digestReport, publishReport, reopenReportFiles, verifyReopenedReport } from '../adapters/dev-roundtrip-report-input.mjs';
import { readMessageCaptures } from '../adapters/dev-roundtrip-report-captures.mjs';
import { loadDevProvider } from '../adapters/dev-provider-admission.mjs';
import { createBidirectionalPreviewEncoding } from '../adapters/dev-transfer-preview-provider.mjs';
import { prepareDevRoundtripReport } from '../application/dev-roundtrip-report.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
export async function compiledReportPorts() {
  // Explicit development-boundary loading of unchanged built domain outputs.
  const message = await import(pathToFileURL(resolve(repo, 'packages/domain/dist/features/ccip-status/message.js')).href);
  const supply = await import(pathToFileURL(resolve(repo, 'packages/domain/dist/supply.js')).href);
  return { projectMessage: message.projectMessage, reconcileSupply: supply.reconcileSupply };
}
export function renderDevRoundtripReport(r) {
  const money = r.monetary;
  const lines = ['Offline DEV roundtrip: ' + r.status + ' [' + r.evidenceClass + ']',
    'Profile: ' + r.profile + '; Sepolia/Devnet; readOnly=true; broadcastAllowed=false',
    'Route: ' + r.routeHash + '; plan: ' + r.planHash, 'Source: ' + r.source.sourceRevision + '; tree: ' + r.source.sourceTree,
    'Pins: ' + JSON.stringify(r.pinHashes), 'Input/capture integrity: ' + JSON.stringify(r.inputHashes),
    'Inventory: ' + r.inventory.knownness + ' (' + r.inventory.scope + '); pending: ' + r.pending.knownness,
    'F=' + money.F + '; L=' + money.L + '; S=' + money.S + '; P_ES=' + money.P_ES + '; P_SE=' + money.P_SE,
    'Reconciliation: ' + JSON.stringify(money.reconciliation), 'Original snapshot/watermarks/freshness: ' + JSON.stringify(r.snapshot)];
  for (const m of r.messages) {
    lines.push(m.identity.messageId + ' ' + m.identity.direction + ': ' + m.status + '; ' + m.reasons.join(', '),
      'Native: ' + JSON.stringify(m.native.availability ?? Object.fromEntries(Object.entries(m.native).map(([k, v]) => [k, { availability: v.availability, capturedConsistency: v.capturedConsistency, prerequisite: v.prerequisite }]))),
      'Capture hashes: ' + JSON.stringify(m.captures));
  }
  lines.push(...money.reasons, ...r.qualifications, 'Report SHA256: ' + r.reportHash);
  return lines.join('\n') + '\n';
}
function reportArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--input', '--reopen', '--provider', '--archives', '--output'].includes(key) || Object.hasOwn(options, key) || !args[i + 1]) {
      throw new Error('Explicit local report options required; duplicate/unknown flags rejected');
    }
    options[key] = args[i + 1];
  }
  if (Boolean(options['--input']) === Boolean(options['--reopen']) || Boolean(options['--provider']) !== Boolean(options['--archives']) || options['--reopen'] && options['--output']) {
    throw new Error('Use --input <header> [--output <new-directory>], or --reopen <directory>; optional --provider <installation> --archives <tarballs>');
  }
  return options;
}
export async function runDevRoundtripReport(args) {
  const options = reportArguments(args), reopened = options['--reopen'] ? await reopenReportFiles(options['--reopen']) : null;
  let provider;
  const admittedProvider = async () => provider ??= await loadDevProvider({ root: options['--provider'], archives: options['--archives'] });
  const loadEncoding = options['--provider'] ? async () => createBidirectionalPreviewEncoding((await admittedProvider()).primitives) : undefined;
  const context = await loadReportInput(reopened?.headerPath ?? options['--input'], loadEncoding), compiled = await compiledReportPorts();
  provider = options['--provider'] ? await admittedProvider() : null;
  const report = await prepareDevRoundtripReport(context, { ...compiled, digest: digestReport,
    readCaptures: (route, expected, message) => readMessageCaptures(route, expected, message, provider?.primitives) });
  const result = { report, summary: renderDevRoundtripReport(report), provider: provider?.evidence ?? { evaluated: false, prerequisite: 'No explicit provider/archives selected' } };
  if (reopened) { verifyReopenedReport(reopened, result); }
  if (options['--output']) { verifyReopenedReport(await publishReport(options['--output'], context.headerBytes, result), result); }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await runDevRoundtripReport(process.argv.slice(2));
    process.stdout.write(JSON.stringify(result.report) + '\n'); process.stderr.write(result.summary);
    process.exitCode = result.report.status === 'inconsistent' ? 1 : result.report.status === 'unknown' ? 2 : 0;
  } catch (error) { process.stderr.write('DEV_REPORT_REJECTED: ' + error.message + '\n'); process.exitCode = 1; }
}
