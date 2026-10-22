/**
 * Cloudflare Worker + KV for the planner's precomputed tables.
 *
 * The read path is the published catalog's:
 *
 *   GET /tables/index.json   {"tables":[...]} — one line per served file (src/tableHeader.ts IndexEntry)
 *   GET /tables/<name>       the gzipped table, byte for byte as uploaded
 *
 * Files are named to the standard the released tables use (src/catalog.ts): `maxed.bin.gz`
 * (also served as `table.bin.gz`), `acct-<24 hex>.bin.gz`, `gear-<24 hex>.bin.gz`,
 * `table-<built name>-te120-489.bin.gz` and its `delivery-<deliveryKey>.bin.gz` alias.
 *
 * KV layout:
 *
 *   index              the whole /tables/index.json body, so a client's catalog read is one KV get
 *   entry:<name>       that file's IndexEntry, so a file read is one KV get plus one blob get
 *   blob:<sha256>      the gzipped bytes (shared by every alias of the same file)
 *   template:<sha256>  the IndexEntry a file was first stored with, for POST /promote rollbacks
 *
 * Writes are rare and authed (UPLOAD_KEY); reads are open and edge-cached.
 */
import { aliasesOf, defaultName, indexBody, indexEntry, isTableName, kindOf, mergeEntries, removeEntries, servedName } from './catalog';
import type { IndexEntry, TableHeader, TableKind } from './tableHeader';
import { UPLOAD_PAGE } from './uploadPage';
import { validateTable } from './validate';

const INDEX_KEY = 'index';
const entryKey = (name: string) => `entry:${name}`;
const blobKey = (sha: string) => `blob:${sha}`;
const templateKey = (sha: string) => `template:${sha}`;
const KINDS: TableKind[] = ['maxed', 'account', 'gear', 'delivery'];
const SHA = /^[0-9a-f]{64}$/;

export interface Env {
  TABLE: KVNamespace;
  /** `wrangler secret put UPLOAD_KEY` (or .dev.vars locally); gates the write endpoints. */
  UPLOAD_KEY?: string;
}

/** Read responses, as the published catalog sends them. */
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

/** The router, exported so tests can drive it with a fake KV and no wrangler. */
export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...CORS,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  if (request.method === 'GET' && (path === '/' || path === '/ui')) {
    return new Response(UPLOAD_PAGE, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (path === '/tables/index.json' && isRead(request)) return serveIndex(request, env, ctx);

  if (path.startsWith('/tables/')) {
    const name = decodeURIComponent(path.slice('/tables/'.length));
    if (!isTableName(name)) return notFound();
    if (isRead(request)) return serveBlob(request, env, ctx, name);
    if (request.method === 'DELETE') {
      const denied = await authed(request, env);
      return denied ?? remove(name, env, url);
    }
  }

  // The planner's own name for the maxed table (precompute/table.bin), kept working.
  if (path === '/table.bin.gz' && isRead(request)) return serveBlob(request, env, ctx, 'table.bin.gz', '/table.bin.gz');

  if (isRead(request) && path === '/meta') {
    const entry = await getEntry(env, 'table.bin.gz');
    return entry ? json(entry) : notFound();
  }
  if (isRead(request) && path.startsWith('/meta/')) {
    const entry = await getEntry(env, decodeURIComponent(path.slice('/meta/'.length)));
    return entry ? json(entry) : notFound();
  }

  if (request.method === 'POST' && path === '/upload') {
    const denied = await authed(request, env);
    return denied ?? upload(request, env, url);
  }

  if (request.method === 'POST' && path === '/promote') {
    const denied = await authed(request, env);
    return denied ?? promote(request, env, url);
  }

  return notFound();
}

const isRead = (request: Request) => request.method === 'GET' || request.method === 'HEAD';

/** The edge cache, or null where there is none (`wrangler dev` without a cache, tests in Node). */
function edge(): Cache | null {
  try {
    return typeof caches === 'undefined' ? null : (caches.default ?? null);
  } catch {
    return null;
  }
}

async function edgeKey(url: string): Promise<Request> {
  return new Request(url, { method: 'GET' });
}

async function purge(urls: string[], origin: string): Promise<void> {
  const cache = edge();
  if (!cache) return;
  for (const path of urls) await cache.delete(await edgeKey(new URL(path, origin).toString()));
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function getEntry(env: Env, name: string): Promise<IndexEntry | null> {
  return (await env.TABLE.get(entryKey(servedName(name)), { type: 'json' })) as IndexEntry | null;
}

/** The whole catalog, exactly as `GET /tables/index.json` sends it (one KV read). */
async function indexText(env: Env): Promise<string> {
  return (await env.TABLE.get(INDEX_KEY)) ?? indexBody([]);
}

async function readIndex(env: Env): Promise<IndexEntry[]> {
  const body = await indexText(env);
  try {
    return (JSON.parse(body) as { tables?: IndexEntry[] }).tables ?? [];
  } catch {
    return [];
  }
}

/** `GET|HEAD /tables/index.json`: edge-cached for 5 minutes, as the published catalog is. */
async function serveIndex(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const cache = edge();
  const key = await edgeKey(request.url);
  if (cache && request.method === 'GET') {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const body = await indexText(env);
  const headers = {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
    'Content-Length': String(new TextEncoder().encode(body).byteLength),
  };
  const response = new Response(request.method === 'HEAD' ? null : body, { headers });
  if (cache && request.method === 'GET') ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/**
 * `GET|HEAD /tables/<name>`: the gzipped file, edge-cached for an hour. The name is an
 * alias, so the bytes are looked up by the content hash the entry carries.
 */
async function serveBlob(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  name: string,
  cachePath = `/tables/${name}`
): Promise<Response> {
  const entry = await getEntry(env, name);
  if (!entry) return notFound();
  const cache = edge();
  const key = await edgeKey(new URL(cachePath, request.url).toString());
  if (cache && request.method === 'GET') {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const blob = await env.TABLE.get(blobKey(entry.sha256), { type: 'arrayBuffer' });
  if (!blob) return notFound();
  const headers = {
    ...CORS,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(blob.byteLength),
    'Cache-Control': 'public, max-age=3600',
  };
  const response = new Response(request.method === 'HEAD' ? null : blob, { headers });
  if (cache && request.method === 'GET') ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

/**
 * The key the write endpoints want: null to proceed, or the 401/500 response. Compares
 * SHA-256 digests rather than the strings, so a timing difference can't leak the key.
 */
async function authed(request: Request, env: Env): Promise<Response | null> {
  const expected = env.UPLOAD_KEY;
  if (!expected) return json({ error: 'UPLOAD_KEY is not set on the worker' }, 500);
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return json({ error: 'an Authorization: Bearer <passkey> header is required' }, 401);
  const [got, want] = await Promise.all([digestHex(match[1]), digestHex(expected)]);
  return got === want ? null : json({ error: 'wrong passkey' }, 401);
}

function digestHex(text: string): Promise<string> {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(toHex);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * POST /upload?name=&kind=&builtWith=&aliases=
 *
 * Body: the file's raw bytes (gzipped or not; `.bin.gz` is stored as uploaded). The header
 * decides the TE range, simulator and gear fields the index lists. The name is the file's
 * own name when given, else derived (`delivery-<key>.bin.gz`, `maxed.bin.gz`); an account
 * or gear table must be named. Its standard aliases are registered too.
 */
async function upload(request: Request, env: Env, url: URL): Promise<Response> {
  const raw = await request.arrayBuffer();
  if (!raw.byteLength) return json({ error: 'the body is the table file itself' }, 400);

  let validated;
  try {
    validated = await validateTable(raw);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const { header, gz, bytes, sha256 } = validated;

  const override = url.searchParams.get('kind');
  if (override && !KINDS.includes(override as TableKind))
    return json({ error: `kind must be one of ${KINDS.join(', ')}` }, 400);

  const askedName = url.searchParams.get('name');
  if (askedName && !isTableName(askedName))
    return json({ error: `"${askedName}" is not a table file name (NAME.bin or NAME.bin.gz)` }, 400);
  const kind = (override as TableKind | null) ?? kindOf(askedName ?? '', header);
  const name = askedName ? servedName(askedName) : defaultName(header, kind);
  if (!name) return json({ error: 'name is required for an account or gear table (nothing else identifies it)' }, 400);
  if (!isTableName(name)) return json({ error: `"${name}" is not a table file name` }, 400);

  const builtWith = header.builtWith ?? url.searchParams.get('builtWith') ?? undefined;
  const stamped: TableHeader = { ...header, builtWith };

  const extra = (url.searchParams.get('aliases') ?? '')
    .split(',')
    .map(a => a.trim())
    .filter(Boolean)
    .map(servedName);
  const bad = extra.find(a => !isTableName(a));
  if (bad) return json({ error: `"${bad}" is not a table file name` }, 400);

  const primary = indexEntry(name, stamped, { bytes, sha256 }, kind);
  const names = [...new Set([name, ...aliasesOf(name, stamped), ...extra])];
  const entries = names.map(n => (n === name ? primary : indexEntry(n, stamped, { bytes, sha256 })));

  await env.TABLE.put(blobKey(sha256), gz);
  await env.TABLE.put(templateKey(sha256), JSON.stringify(primary));
  for (const entry of entries) await env.TABLE.put(entryKey(entry.name), JSON.stringify(entry));
  const index = mergeEntries(await readIndex(env), entries);
  await env.TABLE.put(INDEX_KEY, indexBody(index));

  await purge(['/tables/index.json', '/table.bin.gz', ...names.map(n => `/tables/${n}`)], url.origin);
  return json({ tables: entries });
}

/**
 * POST /promote {"name": "...", "sha256": "..."} — point a name at a file already stored
 * (a rollback, or the same table under a name it was not uploaded as).
 */
async function promote(request: Request, env: Env, url: URL): Promise<Response> {
  let body: { name?: string; sha256?: string };
  try {
    body = (await request.json()) as { name?: string; sha256?: string };
  } catch {
    return json({ error: 'the body is {"name": "...", "sha256": "..."}' }, 400);
  }
  const name = body.name ? servedName(body.name) : '';
  const sha256 = body.sha256 ?? '';
  if (!isTableName(name)) return json({ error: 'name must be a table file name' }, 400);
  if (!SHA.test(sha256)) return json({ error: 'sha256 must be 64 lowercase hex digits' }, 400);

  const bytes = await env.TABLE.get(blobKey(sha256), { type: 'arrayBuffer' });
  if (!bytes) return json({ error: `no stored file with sha256 ${sha256}` }, 404);
  const template = (await env.TABLE.get(templateKey(sha256), { type: 'json' })) as IndexEntry | null;
  if (!template) return json({ error: `no index entry was ever stored for ${sha256}` }, 404);

  const entry: IndexEntry = {
    ...template,
    name,
    kind: kindOf(name, { deliveryKey: template.deliveryKey ?? undefined }),
    bytes: bytes.byteLength,
    sha256,
  };
  await env.TABLE.put(entryKey(name), JSON.stringify(entry));
  await env.TABLE.put(INDEX_KEY, indexBody(mergeEntries(await readIndex(env), [entry])));
  await purge(['/tables/index.json', '/table.bin.gz', `/tables/${name}`], url.origin);
  return json({ tables: [entry] });
}

/** DELETE /tables/<name>: drop the name; the bytes go when no name still uses them. */
async function remove(name: string, env: Env, url: URL): Promise<Response> {
  const entry = await getEntry(env, name);
  if (!entry) return notFound();
  const index = removeEntries(await readIndex(env), [name]);
  const stillUsed = index.some(e => e.sha256 === entry.sha256);
  await env.TABLE.delete(entryKey(name));
  if (!stillUsed) {
    await env.TABLE.delete(blobKey(entry.sha256));
    await env.TABLE.delete(templateKey(entry.sha256));
  }
  await env.TABLE.put(INDEX_KEY, indexBody(index));
  await purge(['/tables/index.json', '/table.bin.gz', `/tables/${name}`], url.origin);
  return json({ removed: name });
}
