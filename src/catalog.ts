/**
 * The catalog's rules: what a file is called, which kind it is, what its index line says,
 * and which aliases it answers to. Pure functions, so the worker and the tests agree.
 *
 * The naming standard is the one the published tables use
 * (github.com/william-egginc/AutoAutoAP/releases/tag/delivery-tables-2026-10-21):
 *
 *   maxed.bin.gz                        the maxed reference table (alias: table.bin.gz)
 *   acct-<24 hex>.bin.gz                one account's own table
 *   gear-<24 hex>.bin.gz                one gear stamp's table
 *   table-metronome-…-te120-489.bin.gz  a delivery-combination table, named as built
 *   delivery-<deliveryKey>.bin.gz       the same table under its gear hash
 *
 * Everything is served gzipped; `.bin` uploads are compressed on the way in.
 */
import type { IndexEntry, TableHeader, TableKind } from './tableHeader';

/** `NAME.bin` or `NAME.bin.gz`: a file name, never a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.bin(?:\.gz)?$/;
const ACCOUNT = /^acct-[0-9a-f]{24}\.bin$/;
const GEAR = /^gear-[0-9a-f]{24}\.bin$/;
const DELIVERY_KEY = /^delivery-[0-9a-f]{8}\.bin$/;
const DELIVERY_NAMED = /^table-.+\.bin$/;
const DELIVERY_KEY_HEX = /^[0-9a-f]{8}$/;

export function isTableName(name: string): boolean {
  return NAME.test(name) && !name.includes('..') && !name.includes('/');
}

/** The name as the store serves it: always `.bin.gz`. */
export function servedName(name: string): string {
  return name.endsWith('.gz') ? name : `${name}.gz`;
}

/** The name without its `.gz`, for the pattern checks ('table.bin'). */
export function baseName(name: string): string {
  return name.replace(/\.gz$/, '');
}

/**
 * Which kind a file is: from its name first (the published catalog names kinds that way),
 * then from the header when the name says nothing (`deliveryKey` → a delivery table,
 * `gear` → a gear table).
 */
export function kindOf(name: string, header: Pick<TableHeader, 'deliveryKey' | 'gear'> = {}): TableKind {
  const base = baseName(name);
  if (ACCOUNT.test(base)) return 'account';
  if (GEAR.test(base)) return 'gear';
  if (base === 'table.bin' || base === 'maxed.bin') return 'maxed';
  if (DELIVERY_KEY.test(base)) return 'delivery';
  if (DELIVERY_NAMED.test(base)) return 'delivery';
  if (header.deliveryKey) return 'delivery';
  if (header.gear) return 'gear';
  return 'maxed';
}

/** One index line for a stored file. `bytes` and `sha256` describe the gzipped bytes served. */
export function indexEntry(
  name: string,
  header: TableHeader,
  gz: { bytes: number; sha256: string },
  kind: TableKind = kindOf(name, header)
): IndexEntry {
  return {
    name,
    kind,
    bytes: gz.bytes,
    sha256: gz.sha256,
    deliveryKey: header.deliveryKey ?? null,
    delivery: header.delivery ?? null,
    from: header.from,
    to: header.to,
    simVersion: header.simVersion ?? null,
    builtWith: header.builtWith ?? null,
    doubleEarnings: header.doubleEarnings ?? null,
    builtAt: header.builtAt ?? null,
  };
}

/**
 * The other names a file answers to. Two come from the standard:
 *
 * - a delivery table is also served as `delivery-<deliveryKey>.bin.gz`, so a client that
 *   knows only the gear hash can fetch it without the built name. An `.asbuilt` variant
 *   is the same gear built the slow way and must not take the alias from the refreshed one.
 * - the maxed table answers to both `maxed.bin.gz` and `table.bin.gz` (the planner's own
 *   `precompute/table.bin` name).
 */
export function aliasesOf(name: string, header: Pick<TableHeader, 'deliveryKey' | 'gear'> = {}): string[] {
  const base = baseName(name);
  const out: string[] = [];
  const key = header.deliveryKey;
  // Only a delivery-kind table takes the hash alias: an account's or gear table's delivery
  // set is one its optimizer picked, not the thing the table is (the published index keeps
  // gear-859e… a gear table although its header names deliveryKey 920db740).
  if (
    key &&
    DELIVERY_KEY_HEX.test(key) &&
    kindOf(name, header) === 'delivery' &&
    !/\.asbuilt\.bin$/.test(base) &&
    !DELIVERY_KEY.test(base)
  )
    out.push(`delivery-${key}.bin.gz`);
  if (base === 'table.bin') out.push('maxed.bin.gz');
  if (base === 'maxed.bin') out.push('table.bin.gz');
  return out.filter(alias => alias !== name);
}

/**
 * The name to store an upload under when the client gives none: its delivery key, or the
 * maxed table's name. An account or gear table must be told its name — none can be
 * derived from the file without the player's id or gear stamp.
 */
export function defaultName(header: Pick<TableHeader, 'deliveryKey' | 'gear'>, kind: TableKind): string | null {
  if (kind === 'delivery' && header.deliveryKey && DELIVERY_KEY_HEX.test(header.deliveryKey))
    return `delivery-${header.deliveryKey}.bin.gz`;
  if (kind === 'maxed') return 'maxed.bin.gz';
  return null;
}

/**
 * Put an entry into the index: replacing a name in place (its position is kept, so the
 * published order only grows) and appending new names at the end.
 */
export function mergeEntries(entries: IndexEntry[], added: IndexEntry[]): IndexEntry[] {
  const out = entries.slice();
  for (const entry of added) {
    const at = out.findIndex(e => e.name === entry.name);
    if (at >= 0) out[at] = entry;
    else out.push(entry);
  }
  return out;
}

/** Drop names from the index; the rest keep their order. */
export function removeEntries(entries: IndexEntry[], names: string[]): IndexEntry[] {
  return entries.filter(e => !names.includes(e.name));
}

/** The index file's body as the published catalog writes it. */
export function indexBody(entries: IndexEntry[]): string {
  return JSON.stringify({ tables: entries } satisfies { tables: IndexEntry[] });
}
