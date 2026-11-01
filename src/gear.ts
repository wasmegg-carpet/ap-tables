/**
 * Gear-table names, ported from AutoAutoAP's src/search/tableGear.ts (the client that chooses a
 * table does the same sums, so a table is reachable under whichever name that client tries):
 *
 *   gear-<24 hex>.bin.gz   the first 12 bytes of SHA-256 of the gear stamp, in one of three forms
 *   acct-<24 hex>.bin.gz   PBKDF2-SHA256 of the player id (the browser's job; see tableName)
 *
 * The three forms, newest first:
 *
 *   v3   the sets as worn (artifacts sorted, stones pooled and sorted), plus only what the
 *        simulator reads of the account: the modelled epic research and the colleggtible effects.
 *   v2   the same sets, with the epic research and colleggtible *tiers* as the save has them,
 *        under `v: 2` so it can never equal a legacy name.
 *   legacy  the stamp exactly as the save wore it, minus its `research` map. Kept until every
 *        deployed table has its v3 alias; the page still tries it last.
 *
 * The same gear gives the same v2/v3 name however the slots and stones are arranged. `gearChanges`
 * compares by the v3 rules; a name is not a claim about the player, only about the gear.
 *
 * The two data tables below are AutoAutoAP's (lib/epicResearch.ts `epicResearchDefs`,
 * lib/collegtibles.ts `colleggtibleDefs`). They change the hash, so they must be updated with it:
 * a new colleggtible or epic research entry is a new name for the same table.
 */

export interface LoadoutSlot {
  artifact: string;
  stones: string[];
}

/** A table's gear stamp, as its header carries it (AutoAutoAP src/search/tableGear.ts `TableGear`). */
export interface TableGear {
  earnings: LoadoutSlot[];
  deliveryBare: LoadoutSlot[];
  deliveryFull: LoadoutSlot[];
  research?: Record<string, number>;
  epicResearch?: Record<string, number>;
  colleggtibles?: Record<string, number>;
}

/** The epic research the planner models (lib/epicResearch.ts `epicResearchDefs`, ids in file order). */
const EPIC_RESEARCH_IDS = [
  'hold_to_hatch',
  'epic_hatchery',
  'epic_internal_incubators',
  'video_doubler_time',
  'epic_clucking',
  'epic_multiplier',
  'cheaper_contractors',
  'bust_unions',
  'cheaper_research',
  'silo_capacity',
  'int_hatch_sharing',
  'int_hatch_calm',
  'accounting_tricks',
  'soul_eggs',
  'prestige_bonus',
  'drone_rewards',
  'epic_egg_laying',
  'transportation_lobbyist',
  'prophecy_bonus',
  'hold_to_research',
  'afx_mission_time',
  'afx_mission_capacity',
];

type Effect =
  | 'earnings'
  | 'awayEarnings'
  | 'ihr'
  | 'elr'
  | 'shippingCap'
  | 'habCap'
  | 'vehicleCost'
  | 'habCost'
  | 'researchCost';

/** The farm effects, and each at 1 until a colleggtible multiplies it. */
const EFFECTS: Effect[] = [
  'earnings',
  'awayEarnings',
  'ihr',
  'elr',
  'shippingCap',
  'habCap',
  'vehicleCost',
  'habCost',
  'researchCost',
];

/**
 * The colleggtibles and what each tier does (lib/collegtibles.ts `colleggtibleDefs`, derived there
 * from lib/customeggs.json: the eggs that carry a buff). Tier index 0-3; anything else is no buff.
 */
const COLLEGGTIBLES: { id: string; effect: Effect; tiers: [number, number, number, number] }[] = [
  { id: 'carbon-fiber', effect: 'shippingCap', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'chocolate', effect: 'awayEarnings', tiers: [1.25, 1.5, 2, 3] },
  { id: 'easter', effect: 'ihr', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'firework', effect: 'earnings', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'flame-retardant', effect: 'habCost', tiers: [0.99, 0.95, 0.88, 0.75] },
  { id: 'gatoregg', effect: 'elr', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'ice', effect: 'researchCost', tiers: [0.99, 0.98, 0.965, 0.95] },
  { id: 'lithium', effect: 'vehicleCost', tiers: [0.98, 0.96, 0.93, 0.9] },
  { id: 'pegg', effect: 'habCap', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'pumpkin', effect: 'shippingCap', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'silicon', effect: 'elr', tiers: [1.01, 1.02, 1.03, 1.05] },
  { id: 'waterballoon', effect: 'researchCost', tiers: [0.99, 0.98, 0.97, 0.95] },
  { id: 'wood', effect: 'awayEarnings', tiers: [1.1, 1.25, 1.5, 2] },
];

/** Code-point order, as AutoAutoAP sorts these keys (`a < b ? -1 : a > b ? 1 : 0`). */
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Whether a header's `gear` is a stamp the names can be worked out from (three sets, nothing else
 *  required). A table packed without one cannot be named by its gear. */
export function isGearStamp(value: unknown): value is TableGear & Record<string, unknown> {
  const stamp = value as Partial<TableGear> | null;
  return (
    !!stamp &&
    typeof stamp === 'object' &&
    Array.isArray(stamp.earnings) &&
    Array.isArray(stamp.deliveryBare) &&
    Array.isArray(stamp.deliveryFull)
  );
}

/** A set as what it does: its artifacts and its stones, each sorted; the slots' order is dropped. */
export function asWorn(slots: LoadoutSlot[]): { artifacts: string[]; stones: string[] } {
  return {
    artifacts: slots.map(s => s.artifact).sort(),
    stones: slots.flatMap(s => s.stones).sort(),
  };
}

/** The epic research the planner models, each at the save's level or 0, keys in code-point order. */
export function simEpicResearch(levels: Record<string, number> | undefined): Record<string, number> {
  return Object.fromEntries(EPIC_RESEARCH_IDS.slice().sort(byCodePoint).map(id => [id, levels?.[id] ?? 0]));
}

/**
 * What the colleggtibles do (every farm effect multiplied by each egg's tier), not which eggs at
 * which tier: the same effect from other eggs is the same farm. Rounded to 12 significant digits so
 * float order cannot split a name.
 */
export function colleggtibleEffects(tiers: Record<string, number> | undefined): Record<string, number> {
  const mods = Object.fromEntries(EFFECTS.map(e => [e, 1])) as Record<Effect, number>;
  for (const def of COLLEGGTIBLES) {
    const tier = tiers?.[def.id] ?? -1;
    if (tier >= 0 && tier <= 3) mods[def.effect] *= def.tiers[tier];
  }
  return Object.fromEntries(Object.keys(mods).sort(byCodePoint).map(k => [k, Number(mods[k as Effect].toPrecision(12))]));
}

/** The stamp as the v2 name hashes it. */
export function canonicalGear(stamp: TableGear): object {
  const keys = (r: Record<string, number> | undefined) =>
    Object.fromEntries(Object.entries(r ?? {}).sort(([a], [b]) => byCodePoint(a, b)));
  return {
    v: 2,
    earnings: asWorn(stamp.earnings),
    deliveryBare: asWorn(stamp.deliveryBare),
    deliveryFull: asWorn(stamp.deliveryFull),
    epicResearch: keys(stamp.epicResearch),
    colleggtibles: keys(stamp.colleggtibles),
  };
}

/** The stamp as the v3 name hashes it: v2's sets, and only what the simulator reads of the account. */
export function canonicalGearV3(stamp: TableGear): object {
  return {
    v: 3,
    earnings: asWorn(stamp.earnings),
    deliveryBare: asWorn(stamp.deliveryBare),
    deliveryFull: asWorn(stamp.deliveryFull),
    epicResearch: simEpicResearch(stamp.epicResearch),
    colleggtibles: colleggtibleEffects(stamp.colleggtibles),
  };
}

/** The stamp as the legacy name hashes it: as worn, minus its `research` map. Key order is the
 *  header's, so this must be given the object exactly as it was parsed. */
export function legacyGear(stamp: Record<string, unknown>): Record<string, unknown> {
  const { research: _research, ...gear } = stamp;
  void _research;
  return gear;
}

/** The 12 bytes of SHA-256 of a stamp's canonical JSON, as a served gear table name. */
async function gearName(canonical: object | Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  // 12 bytes, 24 hex digits: the same prefix AutoAutoAP's gearFile takes.
  const hex = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0'))
    .slice(0, 12)
    .join('');
  return `gear-${hex}.bin.gz`;
}

/**
 * The names a gear stamp is looked up under, in the order the page tries them: v3, v2, legacy.
 * Empty for a header with no usable stamp (a table packed before stamping, say).
 */
export async function gearTableNames(stamp: unknown): Promise<string[]> {
  if (!isGearStamp(stamp)) return [];
  const names = [
    await gearName(canonicalGearV3(stamp)),
    await gearName(canonicalGear(stamp)),
    await gearName(legacyGear(stamp)),
  ];
  return [...new Set(names)];
}

/**
 * The name an account's own table is served under: `acct-` and 24 hex digits of PBKDF2-SHA256 of
 * the player id (fixed salt, 200,000 iterations). The id never leaves the caller — the store only
 * ever sees the name — so this runs in the page, or in a publisher naming a table it built.
 */
export async function tableName(playerId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(playerId), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode('egg-precompute-table-v1'), iterations: 200_000, hash: 'SHA-256' },
    key,
    96
  );
  return `acct-${[...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('')}.bin.gz`;
}
