import { describe, expect, it } from 'vitest';
import {
  aliasesOf,
  defaultName,
  indexBody,
  indexEntry,
  isNameChars,
  isServedName,
  isTableName,
  kindOf,
  mergeEntries,
  removeEntries,
  servedName,
} from '../src/catalog';
import { readFileSync } from 'node:fs';
import type { IndexEntry, TableHeader } from '../src/tableHeader';

const header = (over: Partial<TableHeader> = {}): TableHeader => ({
  version: 1,
  referenceWeek: 1799654400,
  cteBonus: 128.71,
  deliveryScore: 1,
  from: 120,
  to: 489,
  slots: 3,
  builtAt: '2026-10-21T04:22:52.116Z',
  simVersion: '0214e968',
  ...over,
});

describe('names', () => {
  it('accepts the published names and nothing with a path in it', () => {
    for (const name of [
      'table.bin.gz',
      'maxed.bin.gz',
      'acct-09c7c97a50bcbe5d44eea6f7.bin.gz',
      'gear-859e797bf59a848dc75d4cbf.bin.gz',
      'delivery-09f8b316.bin.gz',
      'table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz',
      'table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.asbuilt.bin.gz',
      'whatever.bin',
    ])
      expect(isTableName(name), name).toBe(true);
    for (const name of ['', '../table.bin.gz', 'a/b.bin.gz', 'table.json', '.bin.gz', 'table..bin.gz'])
      expect(isTableName(name), name).toBe(false);
  });

  it('serves everything as .bin.gz', () => {
    expect(servedName('maxed.bin')).toBe('maxed.bin.gz');
    expect(servedName('maxed.bin.gz')).toBe('maxed.bin.gz');
  });
});

describe('the served-name allowlist', () => {
  it('serves the standard families and nothing else', () => {
    for (const name of [
      'table.bin.gz',
      'maxed.bin.gz',
      'delivery-09f8b316.bin.gz',
      'acct-09c7c97a50bcbe5d44eea6f7.bin.gz',
      'gear-859e797bf59a848dc75d4cbf.bin.gz',
      'table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz',
      'table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.asbuilt.bin.gz',
      'table-metronome-T4L_compass-T4E_gusset-T4L-te75-339.bin.gz',
      'maxed.bin',
    ])
      expect(isServedName(name), name).toBe(true);

    for (const name of [
      'custom.bin.gz',
      'index.json',
      'delivery-xyz.bin.gz',
      'acct-123.bin.gz',
      'gear-0123456789abcdef01234567.json',
      'table-metronome-T3E-te120.bin.gz',
      'table-metronome-T3E_compass-T4C_gusset-T2E.bin.gz',
      'wp-login.php',
    ])
      expect(isServedName(name), name).toBe(false);
  });

  it('normalises an upload name to the served form first (`maxed.bin` is `maxed.bin.gz`)', () => {
    expect(isServedName('maxed.bin')).toBe(true);
    expect(isServedName('delivery-09f8b316.bin')).toBe(true);
  });

  it('gates the raw path by its characters before any decoding', () => {
    for (const segment of ['maxed.bin.gz', 'table-x-te1-2.bin.gz', 'a%20b.bin.gz'])
      expect(isNameChars(segment), segment).toBe(true);
    for (const segment of ['', '../x', 'a/b', 'x?y', 'x y', "x'y", 'x'.repeat(129)])
      expect(isNameChars(segment), segment).toBe(false);
  });
});

const gear = JSON.parse(readFileSync(new URL('./fixtures/gear-859e.json', import.meta.url).pathname, 'utf8'));

describe('kindOf', () => {
  it('reads the kind from the published name families', () => {
    expect(kindOf('acct-09c7c97a50bcbe5d44eea6f7.bin.gz')).toBe('account');
    expect(kindOf('gear-859e797bf59a848dc75d4cbf.bin.gz')).toBe('gear');
    expect(kindOf('maxed.bin.gz')).toBe('maxed');
    expect(kindOf('table.bin.gz')).toBe('maxed');
    expect(kindOf('delivery-09f8b316.bin.gz')).toBe('delivery');
    expect(kindOf('table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz')).toBe('delivery');
  });

  it('falls back to the header when the name says nothing', () => {
    expect(kindOf('custom.bin.gz', { deliveryKey: '09f8b316' })).toBe('delivery');
    expect(kindOf('custom.bin.gz', { gear: {} })).toBe('gear');
    expect(kindOf('custom.bin.gz')).toBe('maxed');
  });

  it('keeps a gear table a gear table even when it names its delivery set', () => {
    // gear-859e… has a deliveryKey in its header; the published index still calls it gear.
    expect(kindOf('gear-859e797bf59a848dc75d4cbf.bin.gz', { deliveryKey: '920db740', gear: {} })).toBe('gear');
  });
});

describe('aliasesOf', () => {
  it('serves a delivery table under its delivery key', async () => {
    expect(await aliasesOf('table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz', { deliveryKey: '09f8b316' }))
      .toEqual(['delivery-09f8b316.bin.gz']);
    expect(await aliasesOf('delivery-09f8b316.bin.gz', { deliveryKey: '09f8b316' })).toEqual([]);
  });

  it('does not let an .asbuilt variant take the alias from the refreshed table', async () => {
    expect(await aliasesOf('table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.asbuilt.bin.gz', { deliveryKey: '09f8b316' }))
      .toEqual([]);
  });

  it('answers to both maxed names', async () => {
    expect(await aliasesOf('maxed.bin.gz')).toEqual(['table.bin.gz']);
    expect(await aliasesOf('table.bin.gz')).toEqual(['maxed.bin.gz']);
  });

  it('serves a gear table under the other names its stamp is looked up by', async () => {
    const names = await aliasesOf('gear-859e797bf59a848dc75d4cbf.bin.gz', { gear, deliveryKey: '920db740' } as never);
    // v3 is the uploaded name itself; the other two rules are registered beside it.
    expect(names).toHaveLength(2);
    expect(names.every(n => /^gear-[0-9a-f]{24}\.bin\.gz$/.test(n))).toBe(true);
    expect(names).not.toContain('gear-859e797bf59a848dc75d4cbf.bin.gz');
  });

  it('never makes an account\'s own table reachable by its gear', async () => {
    const names = await aliasesOf('acct-09c7c97a50bcbe5d44eea6f7.bin.gz', { gear } as never);
    expect(names).toEqual([]);
  });
});

describe('defaultName', () => {
  it('names an unnamed delivery or maxed upload, and asks for the rest', async () => {
    expect(await defaultName({ deliveryKey: '09f8b316' }, 'delivery')).toBe('delivery-09f8b316.bin.gz');
    expect(await defaultName({}, 'maxed')).toBe('maxed.bin.gz');
    expect(await defaultName({ gear }, 'account')).toBeNull();
    expect(await defaultName({}, 'delivery')).toBeNull();
  });

  it('names an unnamed gear table from its stamp (the v3 name)', async () => {
    expect(await defaultName({ gear }, 'gear')).toBe('gear-859e797bf59a848dc75d4cbf.bin.gz');
  });
});

describe('indexEntry', () => {
  it('has the published field order and values', () => {
    const entry = indexEntry(
      'delivery-09f8b316.bin.gz',
      header({ deliveryKey: '09f8b316', delivery: ['quantum-metronome-3-2'], doubleEarnings: true }),
      { bytes: 3181357, sha256: 'a'.repeat(64) }
    );
    expect(Object.keys(entry)).toEqual([
      'name', 'kind', 'bytes', 'sha256', 'deliveryKey', 'delivery', 'from', 'to',
      'simVersion', 'builtWith', 'doubleEarnings', 'builtAt',
    ]);
    expect(entry).toEqual({
      name: 'delivery-09f8b316.bin.gz',
      kind: 'delivery',
      bytes: 3181357,
      sha256: 'a'.repeat(64),
      deliveryKey: '09f8b316',
      delivery: ['quantum-metronome-3-2'],
      from: 120,
      to: 489,
      simVersion: '0214e968',
      builtWith: null,
      doubleEarnings: true,
      builtAt: '2026-10-21T04:22:52.116Z',
    });
  });

  it('nulls what the header does not carry, as the maxed table does', () => {
    const entry = indexEntry('maxed.bin.gz', header({ simVersion: undefined }), { bytes: 1, sha256: 'b'.repeat(64) });
    expect(entry.builtWith).toBeNull();
    expect(entry.doubleEarnings).toBeNull();
    expect(entry.deliveryKey).toBeNull();
    expect(entry.delivery).toBeNull();
    expect(entry.simVersion).toBeNull();
  });
});

describe('the index', () => {
  const entry = (name: string, sha = 'c'.repeat(64)): IndexEntry => indexEntry(name, header(), { bytes: 1, sha256: sha });

  it('keeps insertion order and replaces a re-uploaded name in place', () => {
    let index = mergeEntries([], [entry('table.bin.gz'), entry('delivery-09f8b316.bin.gz')]);
    index = mergeEntries(index, [entry('table.bin.gz', 'd'.repeat(64)), entry('gear-abc.bin.gz')]);
    expect(index.map(e => e.name)).toEqual(['table.bin.gz', 'delivery-09f8b316.bin.gz', 'gear-abc.bin.gz']);
    expect(index[0].sha256).toBe('d'.repeat(64));
  });

  it('drops a removed name and leaves the rest alone', () => {
    const index = mergeEntries([], [entry('a.bin.gz'), entry('b.bin.gz'), entry('c.bin.gz')]);
    expect(removeEntries(index, ['b.bin.gz']).map(e => e.name)).toEqual(['a.bin.gz', 'c.bin.gz']);
  });

  it('writes the published body shape', () => {
    expect(indexBody([])).toBe('{"tables":[]}');
    expect(JSON.parse(indexBody([entry('table.bin.gz')]))).toEqual({ tables: [entry('table.bin.gz')] });
  });
});
