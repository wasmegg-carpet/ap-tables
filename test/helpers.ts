/** Test helper: packs cells into the table.bin layout (ported from src/buildTable/pack.ts). */

const FIELDS = 9;
const EGGS = 5;

export interface BuildParams {
  sales: number;
  tier13: boolean;
  waitStart: number;
  saleEnd: number;
  peakELR: number;
  delivered: number[];
}

export interface Cell {
  te: number;
  h: number;
  builds: BuildParams[];
}

export function packTable(
  header: Record<string, unknown> & { from: number; to: number },
  cells: Cell[],
): Uint8Array<ArrayBuffer> {
  const slots = Math.max(1, ...cells.map(c => c.builds.length));
  const json = new TextEncoder().encode(JSON.stringify({ ...header, slots }));
  const start = Math.ceil((4 + json.length) / 8) * 8;
  const count = (header.to - header.from + 1) * WEEK_HOURS * slots * FIELDS;
  const bytes = new Uint8Array(start + count * 8);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  const body = new Float64Array(bytes.buffer, start, count);
  for (const c of cells) {
    c.builds.forEach((b, i) => {
      const at = (((c.te - header.from) * WEEK_HOURS + c.h) * slots + i) * FIELDS;
      body[at] = b.sales + (b.tier13 ? 8 : 0);
      body[at + 1] = b.waitStart;
      body[at + 2] = b.saleEnd;
      body[at + 3] = b.peakELR;
      for (let e = 0; e < EGGS; e++) body[at + 4 + e] = b.delivered[e];
    });
  }
  return bytes;
}

export const WEEK_HOURS = 168; /** Matches the planner's WEEK_HOURS (168 Pacific hours in a week). */
