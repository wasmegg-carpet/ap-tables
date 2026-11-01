/**
 * Publish a folder of tables to the store's KV namespace, writing exactly what `POST /upload`
 * writes (`blob:<sha256>`, `entry:<name>`, `template:<sha256>`, and the catalog last), so the
 * catalog only ever points at bytes that are already there. Publishing adds to the catalog:
 * names already listed keep their position, and `--replace-index` starts a fresh one.
 *
 *   npx vite-node scripts/publish-release.ts -- --dir DIR --account ID --namespace ID \
 *     [--base https://<worker>] [--asbuilt] [--replace-index] [--dry-run]
 *
 * The token is CLOUDFLARE_API_TOKEN, else the OAuth token wrangler is logged in with.
 * Names, kinds, aliases and index lines all come from src/catalog.ts, the worker's own rules.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { aliasesOf, indexBody, indexEntry, kindOf, mergeEntries, servedName } from '../src/catalog';
import type { IndexEntry } from '../src/tableHeader';
import { validateTable } from '../src/validate';

const args = process.argv.slice(2);
const arg = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);

const dir = arg('dir') ?? '';
const account = arg('account') ?? '';
const namespace = arg('namespace') ?? '';
const base = arg('base');
const includeAsBuilt = has('asbuilt');
const replaceIndex = has('replace-index');
const dryRun = has('dry-run');
if (!dir || !account || !namespace) throw new Error('usage: --dir DIR --account ID --namespace ID [--base URL] [--asbuilt] [--replace-index] [--dry-run]');

function token(): string {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const config = readFileSync(join(homedir(), 'Library/Preferences/.wrangler/config/default.toml'), 'utf8');
  const match = /^oauth_token = "([^"]+)"/m.exec(config);
  if (!match) throw new Error('no CLOUDFLARE_API_TOKEN and no wrangler OAuth token');
  return match[1];
}
const AUTH = { Authorization: `Bearer ${token()}` };
const API = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values`;

async function put(key: string, value: string | Uint8Array): Promise<void> {
  const res = await fetch(`${API}/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: { ...AUTH, 'Content-Type': 'application/octet-stream' },
    body: value as BodyInit,
  });
  if (!res.ok) throw new Error(`PUT ${key}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

/** The catalog already stored (empty when there is none), so a publish adds to it. */
async function storedIndex(): Promise<IndexEntry[]> {
  if (replaceIndex) return [];
  const res = await fetch(`${API}/index`, { headers: AUTH });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GET index: ${res.status} ${(await res.text()).slice(0, 300)}`);
  try {
    return ((await res.json()) as { tables?: IndexEntry[] }).tables ?? [];
  } catch {
    return [];
  }
}

const files = readdirSync(dir)
  .filter(f => f.endsWith('.bin.gz') && (includeAsBuilt || !f.includes('.asbuilt')))
  .sort();
if (!files.length) throw new Error(`no .bin.gz files in ${dir}`);

/** Validate every file and work out the records, exactly as an upload would. */
const prepared: { entry: IndexEntry; aliases: IndexEntry[]; gz: Uint8Array; sha256: string }[] = [];
for (const file of files) {
  const name = servedName(basename(file));
  const raw = new Uint8Array(readFileSync(join(dir, file)));
  const v = await validateTable(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);
  prepared.push({
    entry: indexEntry(name, v.header, { bytes: v.bytes, sha256: v.sha256 }, kindOf(name, v.header)),
    aliases: (await aliasesOf(name, v.header)).map(a => indexEntry(a, v.header, { bytes: v.bytes, sha256: v.sha256 })),
    gz: raw,
    sha256: v.sha256,
  });
}

const added = prepared.flatMap(p => [p.entry, ...p.aliases]);
const existing = await storedIndex();
const catalog = mergeEntries(existing, added);
const body = indexBody(catalog);
console.log(`${prepared.length} files -> ${added.length} names; catalog ${existing.length} -> ${catalog.length}`);
for (const p of prepared)
  console.log(`  ${p.entry.name}  ${p.sha256.slice(0, 12)}…  aliases: ${p.aliases.map(a => a.name).join(', ') || '—'}`);

if (dryRun) {
  console.log('\n--dry-run: nothing written. Catalog body would be:');
  console.log(body.slice(0, 400) + (body.length > 400 ? '…' : ''));
  process.exit(0);
}

// Blobs and entries first, the catalog last: a reader never sees a name without its bytes.
for (const p of prepared) {
  await put(`blob:${p.sha256}`, p.gz);
  await put(`template:${p.sha256}`, JSON.stringify(p.entry));
  for (const entry of [p.entry, ...p.aliases]) await put(`entry:${entry.name}`, JSON.stringify(entry));
  console.log(`stored ${p.entry.name} (+${p.aliases.length} alias)`);
}
await put('index', body);
console.log(`wrote index (${catalog.length} names)`);

if (base) {
  // KV is eventually consistent: give it up to ~2 minutes to show the whole catalog.
  const want = new Map(catalog.map(e => [e.name, e]));
  for (let attempt = 1; attempt <= 24; attempt++) {
    const res = await fetch(`${base}/tables/index.json`, { cache: 'no-store' });
    const got = ((await res.json()) as { tables: IndexEntry[] }).tables;
    const same =
      got.length === catalog.length && got.every(e => JSON.stringify(e) === JSON.stringify(want.get(e.name)));
    console.log(`verify ${attempt}: ${got.length}/${catalog.length} names, ${same ? 'identical' : 'not yet'}`);
    if (same) {
      const file = prepared[0];
      const served = new Uint8Array(await (await fetch(`${base}/tables/${file.entry.name}`, { cache: 'no-store' })).arrayBuffer());
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', served)), b => b.toString(16).padStart(2, '0')).join('');
      console.log(`file check: ${file.entry.name} sha256 ${digest === file.sha256 ? 'matches' : 'MISMATCH'}`);
      process.exit(digest === file.sha256 ? 0 : 1);
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('the catalog did not converge in 2 minutes');
}
