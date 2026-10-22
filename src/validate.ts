/**
 * Table upload validation, ported from the planner's readTable
 * (wasmegg/ascension-planner/src/search/precomputedTable.ts). The same little-endian
 * uint32-JSON-header + float64 layout; every check that catches a truncated or corrupt
 * table (which would otherwise read as "empty cells" and silently misroute) must pass
 * before anything is written to KV.
 *
 * What goes into KV is the gzipped file as served, and the published catalog's `sha256`
 * is the digest of exactly those bytes (not of the unpacked table), so an upload that
 * already is a `.gz` is stored byte for byte and one that is not is compressed here.
 */
import type { TableHeader } from './tableHeader';

const FIELDS = 9;
const WEEK_HOURS = 168;
/** Headroom under KV's 25 MiB per-value limit. */
export const MAX_UPLOAD_BYTES = 24 * 1024 * 1024;
/** A real table unpacks to 13.4 MB (TE 75–489); this stops a gzip bomb before it fills memory. */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

export interface Validated {
  header: TableHeader;
  /** The bytes to store and serve: gzip, byte for byte when the upload already was. */
  gz: ArrayBuffer;
  /** `gz.byteLength`. */
  bytes: number;
  /** Hex SHA-256 of `gz`: the index's `sha256`. */
  sha256: string;
}

/** The bytes of a table, gzipped or not (gzip's magic number decides), as an ArrayBuffer. */
export async function unpackTableBytes(bytes: ArrayBuffer): Promise<ArrayBuffer> {
  if (!isGzip(bytes)) return bytes;
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UNPACKED_BYTES) {
      await reader.cancel();
      throw new Error(`the table unpacks to more than ${MAX_UNPACKED_BYTES / 1048576} MiB`);
    }
    chunks.push(value);
  }
  return concat(chunks, total).buffer as ArrayBuffer;
}

/** The upload as the gzipped bytes to store: unchanged when it already is gzip. */
export async function toGzip(raw: ArrayBuffer): Promise<ArrayBuffer> {
  if (isGzip(raw)) return raw;
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

/**
 * The full readTable validation: header, exact byte length, and a spot decode of
 * the first non-empty cell. Throws `Error` with a user-facing message on failure.
 */
export async function validateTable(raw: ArrayBuffer): Promise<Validated> {
  if (raw.byteLength > MAX_UPLOAD_BYTES)
    throw new Error(`file is ${(raw.byteLength / 1048576).toFixed(1)} MiB; the limit is ${MAX_UPLOAD_BYTES / 1048576} MiB`);
  const bytes = await unpackTableBytes(raw);
  const view = new DataView(bytes);
  const len = bytes.byteLength >= 4 ? view.getUint32(0, true) : 0;
  let header: TableHeader;
  try {
    if (!len || 4 + len > bytes.byteLength) throw new Error('bad length');
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, len))) as TableHeader;
  } catch {
    throw new Error('that file is not a precomputed table');
  }
  if (header.version !== 1) throw new Error(`precomputed table version ${header.version} is not supported`);
  if (!(header.slots > 0)) throw new Error('the header has no build slots');
  if (!Number.isInteger(header.from) || !Number.isInteger(header.to))
    throw new Error('the header has no TE range');
  if (!(header.to >= header.from)) throw new Error(`the header's TE range ${header.from}–${header.to} is backwards`);
  if (header.deliveryKey !== undefined && !/^[0-9a-f]{8}$/.test(header.deliveryKey))
    throw new Error(`the header's deliveryKey ${header.deliveryKey} is not 8 hex digits`);
  const start = Math.ceil((4 + len) / 8) * 8;
  // A file cut short would read its missing cells as empty, and the finder would quietly route
  // around them.
  const expected = start + (header.to - header.from + 1) * WEEK_HOURS * header.slots * FIELDS * 8;
  if (bytes.byteLength !== expected)
    throw new Error(`the precomputed table is incomplete (${bytes.byteLength} of ${expected} bytes)`);
  spotDecode(new Float64Array(bytes, start), header);
  const gz = await toGzip(raw);
  const sha256 = toHex(await crypto.subtle.digest('SHA-256', gz));
  return { header, gz, bytes: gz.byteLength, sha256 };
}

function isGzip(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 2) return false;
  const head = new Uint8Array(bytes, 0, 2);
  return head[0] === 0x1f && head[1] === 0x8b;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Decode the first non-empty cell and sanity-check its numbers. */
function spotDecode(body: Float64Array, header: TableHeader): void {
  const cells = (header.to - header.from + 1) * WEEK_HOURS * header.slots * FIELDS;
  for (let at = 0; at < cells; at += FIELDS) {
    const flags = body[at];
    if (!flags) continue;
    if (flags >= 16 || !Number.isFinite(flags)) throw new Error('cell build flags are out of range');
    for (let i = 1; i < FIELDS; i++) {
      const v = body[at + i];
      if (!Number.isFinite(v)) throw new Error(`cell build field ${i} is not a number`);
      if (v < 0) throw new Error(`cell build field ${i} is negative`);
    }
    const [waitStart, saleEnd] = [body[at + 1], body[at + 2]];
    if (saleEnd < waitStart) throw new Error("a cell's sale ends before it starts");
    return;
  }
  throw new Error('the table has no builds in it');
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}
