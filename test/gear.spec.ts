import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  asWorn,
  canonicalGear,
  canonicalGearV3,
  colleggtibleEffects,
  gearTableNames,
  isGearStamp,
  legacyGear,
  simEpicResearch,
  tableName,
  type TableGear,
} from '../src/gear';

/** A real gear stamp: the header of the deployed gear-859e… table (AutoAutoAP built it). */
const gear: TableGear = JSON.parse(
  readFileSync(new URL('./fixtures/gear-859e.json', import.meta.url).pathname, 'utf8')
);

const slot = (artifact: string, stones: string[] = []): { artifact: string; stones: string[] } => ({ artifact, stones });

describe('gear table names', () => {
  it('reproduces the name the deployed table is served under (v3, tried first)', async () => {
    const names = await gearTableNames(gear);
    expect(names).toHaveLength(3);
    expect(names[0]).toBe('gear-859e797bf59a848dc75d4cbf.bin.gz');
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^gear-[0-9a-f]{24}\.bin\.gz$/);
  });

  it('gives the same v2 and v3 names however the slots and stones are arranged', async () => {
    const shuffled: TableGear = {
      ...gear,
      earnings: [...gear.earnings].reverse().map(s => ({ ...s, stones: [...s.stones].reverse() })),
      deliveryBare: [...gear.deliveryBare].reverse(),
    };
    const [a, b] = [await gearTableNames(gear), await gearTableNames(shuffled)];
    expect(b[0]).toBe(a[0]); // v3
    expect(b[1]).toBe(a[1]); // v2
    expect(b[2]).not.toBe(a[2]); // legacy hashes the stamp as worn
  });

  it('names the legacy form from the stamp as it is, without its research map', async () => {
    expect(legacyGear(gear as unknown as Record<string, unknown>)).not.toHaveProperty('research');
    expect(Object.keys(legacyGear(gear as unknown as Record<string, unknown>))).toEqual([
      'earnings',
      'deliveryBare',
      'deliveryFull',
      'epicResearch',
      'colleggtibles',
    ]);
  });
});

describe('canonicalization', () => {
  it('asWorn sorts the artifacts and pools the stones', () => {
    expect(asWorn([slot('b', ['y', 'x']), slot('a', ['z'])])).toEqual({
      artifacts: ['a', 'b'],
      stones: ['x', 'y', 'z'],
    });
  });

  it('simEpicResearch keeps only the modelled research, each 0 by default, keys sorted', () => {
    const research = simEpicResearch({ soul_eggs: 140, silo_quality: 40, warp_shift: 16 });
    expect(Object.keys(research)).toHaveLength(22);
    expect(research.soul_eggs).toBe(140);
    expect(research).not.toHaveProperty('silo_quality');
    expect(research).not.toHaveProperty('warp_shift');
    expect(research.accounting_tricks).toBe(0);
    expect(Object.keys(research)).toEqual(Object.keys(research).slice().sort());
  });

  it('colleggtibleEffects multiplies each farm effect and rounds to 12 significant digits', () => {
    const effects = colleggtibleEffects({ firework: 3, 'carbon-fiber': 3, ice: 3, pumpkin: 0 });
    expect(Object.keys(effects)).toEqual([
      'awayEarnings',
      'earnings',
      'elr',
      'habCap',
      'habCost',
      'ihr',
      'researchCost',
      'shippingCap',
      'vehicleCost',
    ]);
    expect(effects.earnings).toBe(1.05); // firework tier 4
    expect(effects.shippingCap).toBe(1.0605); // carbon-fiber 1.05 × pumpkin tier 1 (1.01)
    expect(effects.researchCost).toBe(0.95); // ice tier 4
    expect(effects.habCap).toBe(1); // no colleggtible touched it
  });

  it('v3 and v2 differ only in how the account is read', () => {
    const stamp: TableGear = {
      earnings: [slot('E', ['s'])],
      deliveryBare: [slot('D', ['s'])],
      deliveryFull: [slot('D', ['s'])],
      epicResearch: { soul_eggs: 140, silo_quality: 40 },
      colleggtibles: { firework: 3, unknown: 3 },
    };
    const v2 = canonicalGear(stamp) as Record<string, unknown>;
    const v3 = canonicalGearV3(stamp) as Record<string, unknown>;
    expect(v2.v).toBe(2);
    expect(v3.v).toBe(3);
    // v2 hashes the save's own maps; v3 only the modelled research and the effects.
    expect(v2.epicResearch).toEqual({ silo_quality: 40, soul_eggs: 140 });
    expect(Object.keys(v3.epicResearch as object)).toHaveLength(22);
    expect(v2.colleggtibles).toEqual({ firework: 3, unknown: 3 });
    expect(v3.colleggtibles).toEqual(expect.objectContaining({ earnings: 1.05 }));
  });
});

describe('isGearStamp', () => {
  it('accepts a stamp with the three sets and rejects anything else', () => {
    expect(isGearStamp(gear)).toBe(true);
    expect(isGearStamp({ earnings: [], deliveryBare: [] })).toBe(false);
    expect(isGearStamp({ earnings: [], deliveryBare: [], deliveryFull: [] })).toBe(true);
    expect(isGearStamp(null)).toBe(false);
    expect(isGearStamp('gear')).toBe(false);
  });
});

describe('tableName', () => {
  it('is the PBKDF2 name the page works out, in the served form', async () => {
    // The same value AutoAutoAP's tableGear.ts `tableName` gives for this id (checked against it).
    expect(await tableName('EI1000000000000000')).toBe('acct-2b72b34179368e2223a9324f.bin.gz');
  });

  it('is stable per id and different for another', async () => {
    expect(await tableName('EI1000000000000000')).toBe(await tableName('EI1000000000000000'));
    expect(await tableName('EI2000000000000000')).not.toBe(await tableName('EI1000000000000000'));
  });
});
