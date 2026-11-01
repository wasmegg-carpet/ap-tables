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
import { gearTableNames } from './gear';
import type { IndexEntry, TableHeader, TableKind } from './tableHeader';

/** `NAME.bin` or `NAME.bin.gz`: a file name, never a path. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.bin(?:\.gz)?$/;
const ACCOUNT = /^acct-[0-9a-f]{24}\.bin$/;
const GEAR = /^gear-[0-9a-f]{24}\.bin$/;
const DELIVERY_KEY = /^delivery-[0-9a-f]{8}\.bin$/;
const DELIVERY_NAMED = /^table-.+\.bin$/;
const DELIVERY_KEY_HEX = /^[0-9a-f]{8}$/;

/**
 * The names the store serves — and therefore the only names it accepts at upload. Anything
 * else is a 404 before the worker decodes the path or touches KV, so a scanner cannot make
 * it pay for random names. A new naming family is a change here, deliberately.
 *
 *   table.bin.gz | maxed.bin.gz
 *   delivery-<8 hex>.bin.gz
 *   acct-<24 hex>.bin.gz | gear-<24 hex>.bin.gz
 *   table-<built name>-te<from>-<to>[.asbuilt].bin.gz
 */
const SERVED = new RegExp(
  '^(?:' +
    [
      '(?:table|maxed)\\.bin\\.gz',
      'delivery-[0-9a-f]{8}\\.bin\\.gz',
      '(?:acct|gear)-[0-9a-f]{24}\\.bin\\.gz',
      'table-[A-Za-z0-9_.-]+-te\\d+-\\d+(?:\\.asbuilt)?\\.bin\\.gz',
    ].join('|') +
    ')$'
);

/** Whether this store serves (and accepts) a name. Exposed as its source, for tests. */
export const SERVED_NAME = SERVED;

/** `index.json` is the catalog itself, not a table file. */
export const INDEX_NAME = 'index.json';

/** A served table name (not the catalog). */
export function isServedName(name: string): boolean {
  return SERVED.test(servedName(name));
}

/**
 * Cheap gate for the raw path segment, before percent-decoding or a KV read: the characters
 * a served name can be written with. A path with anything else — `'`, `?`, `/`, spaces,
 * `../` — is answered without KV being consulted.
 */
export function isNameChars(segment: string): boolean {
  return segment.length > 0 && segment.length <= 128 && /^[A-Za-z0-9._%~-]+$/.test(segment);
}

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
  // A gear stamp outranks a delivery key: a table built on an account's gear carries both, and
  // what it is is the gear (the Table Builder's fixed-delivery tables carry only the key).
  if (header.gear) return 'gear';
  if (header.deliveryKey) return 'delivery';
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
 * The other names a file answers to, as the client looks them up (src/gear.ts, ported from
 * AutoAutoAP's table naming):
 *
 * - a gear table is also served under the canonical v3 and v2 names of its gear stamp and the
 *   legacy one, so a page that works the name out from a save finds it whichever rule it uses.
 *   Only for `gear-` tables: an `acct-` table is one account's own simulation and must not
 *   become reachable by everyone wearing that gear.
 * - a delivery table is also served as `delivery-<deliveryKey>.bin.gz`, so a client that
 *   knows only the gear hash can fetch it without the built name. An `.asbuilt` variant
 *   is the same gear built the slow way and must not take the alias from the refreshed one.
 * - the maxed table answers to both `maxed.bin.gz` and `table.bin.gz` (the planner's own
 *   `precompute/table.bin` name).
 */
export async function aliasesOf(
  name: string,
  header: Pick<TableHeader, 'deliveryKey' | 'gear' | 'gearTo' | 'fake'> = {}
): Promise<string[]> {
  const base = baseName(name);
  const out: string[] = [];
  const key = header.deliveryKey;
  // Only a delivery-kind table takes the hash alias: an account's or gear table's delivery
  // set is one its optimizer picked, not the thing the table is (the published index keeps
  // gear-859e… a gear table although its header names deliveryKey 920db740).
  const kind = kindOf(name, header);
  if (
    key &&
    DELIVERY_KEY_HEX.test(key) &&
    kind === 'delivery' &&
    !/\.asbuilt\.bin$/.test(base) &&
    !DELIVERY_KEY.test(base)
  )
    out.push(`delivery-${key}.bin.gz`);
  if (base === 'table.bin') out.push('maxed.bin.gz');
  if (base === 'maxed.bin') out.push('table.bin.gz');
  if (kind === 'gear') out.push(...(await gearTableNames(header.gear)));
  return [...new Set(out.filter(alias => alias !== name))];
}

/**
 * The name to store an upload under when the client gives none: its delivery key, or the
 * maxed table's name. An account or gear table must be told its name — none can be
 * derived from the file without the player's id or gear stamp.
 */
export async function defaultName(
  header: Pick<TableHeader, 'deliveryKey' | 'gear'>,
  kind: TableKind
): Promise<string | null> {
  if (kind === 'delivery' && header.deliveryKey && DELIVERY_KEY_HEX.test(header.deliveryKey))
    return `delivery-${header.deliveryKey}.bin.gz`;
  if (kind === 'maxed') return 'maxed.bin.gz';
  // A gear table names itself from its stamp (the v3 name); an account's table cannot, because
  // the name comes from the player id, which the store must never be given.
  if (kind === 'gear') {
    const [v3] = await gearTableNames(header.gear);
    if (v3) return v3;
  }
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
