import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { posix } from 'node:path';

const fail = reason => { throw new Error('DEV provider archive: ' + reason); };
const zero = bytes => bytes.every(byte => byte === 0);
export const payloadHash = bytes => createHash('sha256').update(bytes).digest('hex');

function text(bytes) {
  const end = bytes.indexOf(0), value = end < 0 ? bytes : bytes.subarray(0, end);
  if (value.some(byte => byte < 32 || byte > 126) || (end >= 0 && !zero(bytes.subarray(end)))) {
    fail('invalid header text');
  }
  return value.toString('ascii');
}
function octal(bytes) {
  const value = text(bytes).trim();
  if (!/^[0-7]+$/.test(value)) { fail('unsupported numeric field'); }
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) { fail('numeric field exceeds bound'); }
  return number;
}
export function payloadPath(value) {
  if (typeof value !== 'string' || value.length > 512 || !value ||
      !/^[\x21-\x7e]+$/.test(value) || value.includes('\\') ||
      value.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('unsafe path');
  }
  return value;
}

function readTar(archive, integrity) {
  if (!Buffer.isBuffer(archive) || archive.length > 32 * 1024 * 1024 ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity ?? '') ||
      createHash('sha512').update(archive).digest('base64') !== integrity.slice(7)) {
    fail('integrity mismatch');
  }
  let tar;
  try { tar = gunzipSync(archive, { maxOutputLength: 64 * 1024 * 1024 }); }
  catch { fail('invalid or excessive gzip'); }
  if (tar.length % 512 !== 0) { fail('truncated framing'); }
  return tar;
}
function readFileHeader(header) {
  let checksum = 0;
  for (let i = 0; i < 512; i++) { checksum += i >= 148 && i < 156 ? 32 : header[i]; }
  if (checksum !== octal(header.subarray(148, 156))) { fail('checksum mismatch'); }
  // All selected retained archives witness this POSIX ustar spelling.
  const magic = header.subarray(257, 265).toString('hex');
  if (magic !== '7573746172003030') { fail('unsupported tar format'); }
  if (header[156] !== 48 || text(header.subarray(157, 257))) { fail('unsupported type or link'); }
  const prefix = text(header.subarray(345, 500));
  const name = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
  if (!name.startsWith('package/')) { fail('unreviewed archive prefix'); }
  const path = payloadPath(name.slice(8));
  const mode = octal(header.subarray(100, 108)), size = octal(header.subarray(124, 136));
  if (![0o644, 0o664, 0o666, 0o755].includes(mode) || size > 32 * 1024 * 1024) {
    fail('unreviewed mode or excessive file');
  }
  return { path, mode, size };
}
function addParentDirectories(entries) {
  // The actual npm replay applies umask 077 and creates precisely these parents.
  for (const [path, entry] of entries) {
    // Visit only files; directories appended to this live iterator are already handled.
    if (entry.type !== 'file') { continue; }
    let parent = posix.dirname(path);
    while (parent !== '.') {
      if (entries.has(parent) && entries.get(parent).type !== 'directory') { fail('file as parent'); }
      entries.set(parent, { type: 'directory', mode: 0o700 });
      if (entries.size > 8192) { fail('excessive parents'); }
      parent = posix.dirname(parent);
    }
  }
}

/** Private fixed-line npm reader. Selected archives witness regular ustar files only.
 * No extraction, PAX/GNU extensions, links, device nodes or caller-authored receipts.
 * The loader supplies integrity from its independently hash-pinned npm lock.
 */
export function readDevProviderArchive(archive, integrity) {
  const tar = readTar(archive, integrity);
  const entries = new Map();
  let offset = 0, terminated = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (zero(header)) {
      if (tar.length - offset < 512 || !zero(tar.subarray(offset))) { fail('invalid termination'); }
      terminated = true;
      break;
    }
    const { path, mode, size } = readFileHeader(header);
    const next = offset + Math.ceil(size / 512) * 512;
    if (next > tar.length || !zero(tar.subarray(offset + size, next))) { fail('truncated file or nonzero padding'); }
    if (entries.has(path) || entries.size >= 4096) { fail('duplicate or excessive paths'); }
    const bytes = tar.subarray(offset, offset + size);
    entries.set(path, { type: 'file', mode: mode & 0o700, bytes, sha256: payloadHash(bytes) });
    offset = next;
  }
  if (!terminated || entries.size === 0) { fail('missing termination or empty payload'); }
  addParentDirectories(entries);
  return entries;
}
