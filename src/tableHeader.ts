/**
 * The table header, matching the planner's TableHeader
 * (wasmegg/ascension-planner/src/search/precomputedTable.ts).
 *
 * Only `version`, the TE range and `slots` are used for validation; everything else is
 * carried into the index so a client can pick a table without downloading it. The
 * optional fields are what the Table Builder writes (delivery tables name their gear
 * sets) and what the site's generator writes (`gear`, `k3`, `epicResearch`).
 */
export interface TableHeader {
  version: 1;
  /** Unix second of the Monday 00:00 Pacific every cell was simulated from. */
  referenceWeek: number;
  cteBonus: number;
  deliveryScore: number;
  from: number;
  to: number;
  slots: number;
  builtAt: string;
  /** The simulator the cells came from (scripts/simVersion.ts). */
  simVersion?: string;
  /** Who built it and with what (`joo31b596bb-dbl-bc7c3daa`): provenance, not a stamp. */
  builtWith?: string;
  /** A video doubler (or Ultra) was assumed on. */
  doubleEarnings?: boolean;
  /** Artifact ids worn for earnings and for delivery (`quantum-metronome-3-2`). */
  earnings?: string[];
  delivery?: string[];
  /** 8 hex of the delivery set: the `delivery-<key>.bin.gz` alias names it. */
  deliveryKey?: string;
  /** Stone counts by family (`tachyon-stone-4: 12`). */
  stones?: Record<string, number>;
  /** An account's or gear table's gear stamp (search/tableGear.ts). */
  gear?: unknown;
  /** The research a build waits with and the table's delivery set there. */
  k3?: {
    research?: Record<string, number>;
    delivery?: unknown[];
    peak?: number;
  };
  epicResearch?: Record<string, number>;
  colleggtibleEffects?: Record<string, number>;
  settings?: { assumeDoubleEarnings?: boolean; deferForEarnings?: boolean };
  /** A gear table joined to a maxed one below this start TE. */
  gearTo?: number;
  /** Rows filled from the nearest real ones to try the page before a table is finished. */
  fake?: boolean;
  deferForEarnings?: boolean;
}

/** The four kinds the index lists. */
export type TableKind = 'maxed' | 'account' | 'gear' | 'delivery';

/**
 * One line of `GET /tables/index.json`, byte-compatible with the published catalog
 * (`https://aaap-tables.williamthe5thc.workers.dev/tables/index.json`). Field order is
 * the published order; the entries are emitted in the order tables were first uploaded.
 */
export interface IndexEntry {
  name: string;
  kind: TableKind;
  /** Length of the file as served (gzipped). */
  bytes: number;
  /** SHA-256 of the file as served (gzipped bytes), not of the unpacked table. */
  sha256: string;
  deliveryKey: string | null;
  delivery: string[] | null;
  from: number;
  to: number;
  simVersion: string | null;
  builtWith: string | null;
  doubleEarnings: boolean | null;
  builtAt: string | null;
}

/** The index file's body. */
export interface TableIndex {
  tables: IndexEntry[];
}
