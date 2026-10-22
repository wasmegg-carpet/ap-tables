import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateTable, MAX_UPLOAD_BYTES } from '../src/validate';
import { packTable, type Cell } from './helpers';

/** The deployed maxed table, the same file the planner serves from public/. */
const REAL_GZ = readFileSync(new URL('../../egg-fresh/wasmegg/ascension-planner/public/instant/table.bin.gz', import.meta.url).pathname);
const realGz = () => sliceBuffer(new Uint8Array(REAL_GZ));

function tinyTable(): { header: Record<string, unknown> & { from: number; to: number }; bytes: Uint8Array } {
  const header = { version: 1, referenceWeek: 1799664000, cteBonus: 0, deliveryScore: 0, from: 120, to: 120, builtAt: '2026-10-20T00:00:00Z', simVersion: 'test' };
  const cell: Cell = {
    te: 120,
    h: 3,
    builds: [{ sales: 2, tier13: true, waitStart: 3600, saleEnd: 7200, peakELR: 1.5e13, delivered: [1e15, 2e15, 3e15, 4e15, 5e15] }],
  };
  return { header, bytes: packTable(header, [cell]) };
}

describe('validateTable', () => {
  it('accepts the real deployed table', async () => {
    const v = await validateTable(realGz());
    expect(v.header.version).toBe(1);
    expect(v.header.from).toBeGreaterThan(0);
    expect(v.header.to).toBeGreaterThan(v.header.from);
    expect(v.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a gzipped synthetic table and hashes it deterministically', async () => {
    const { bytes } = tinyTable();
    const gz = new Uint8Array(await gzipBytes(bytes));
    const first = await validateTable(sliceBuffer(gz));
    const second = await validateTable(gz.buffer as ArrayBuffer);
    expect(first.header.from).toBe(120);
    expect(first.header.to).toBe(120);
    expect(first.sha256).toBe(second.sha256);
  });

  it('rejects random bytes', async () => {
    await expect(validateTable(sliceBuffer(new TextEncoder().encode('hello world, not a table'))))
      .rejects.toThrow('not a precomputed table');
  });

  it('rejects a truncated table', async () => {
    const { bytes } = tinyTable();
    const cut = bytes.subarray(0, bytes.byteLength - 8);
    await expect(validateTable(sliceBuffer(cut))).rejects.toThrow(/incomplete/);
  });

  it('rejects a wrong header version', async () => {
    const { header, bytes } = tinyTable();
    const bad = packTable({ ...header, version: 2 }, []);
    await expect(validateTable(sliceBuffer(bad))).rejects.toThrow('version 2 is not supported');
  });

  it('rejects a table with no builds', async () => {
    const { header } = tinyTable();
    const empty = packTable(header, []);
    await expect(validateTable(sliceBuffer(empty))).rejects.toThrow('no builds');
  });

  it('rejects oversized uploads before parsing', async () => {
    const big = new ArrayBuffer(MAX_UPLOAD_BYTES + 1);
    await expect(validateTable(big)).rejects.toThrow('the limit is 24 MiB');
  });
});

/** Copies a subarray view into its own ArrayBuffer (validateTable needs a standalone buffer). */
function sliceBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function gzipBytes(bytes: Uint8Array): Promise<ArrayBuffer> {
  // CompressionStream('gzip') is available in Node.
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(bytes).then(() => writer.close());
  return await new Response(cs.readable).arrayBuffer();
}
