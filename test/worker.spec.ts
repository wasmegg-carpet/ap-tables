import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { handle, type Env } from '../src/worker';
import { packTable, type Cell } from './helpers';

/** A KV namespace in a Map: get/put/delete with the three read types the worker uses. */
class FakeKV {
  readonly store = new Map<string, ArrayBuffer | string>();
  /** Reads so far: the allowlist's whole point is that a bad path costs none. */
  gets = 0;

  async get(key: string, opts?: { type?: 'text' | 'json' | 'arrayBuffer' }): Promise<unknown> {
    this.gets++;
    const value = this.store.get(key);
    if (value === undefined) return null;
    const text = typeof value === 'string' ? value : new TextDecoder().decode(value);
    if (opts?.type === 'json') return JSON.parse(text);
    if (opts?.type === 'arrayBuffer') return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value;
    return text;
  }

  async put(key: string, value: ArrayBuffer | string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const ORIGIN = 'https://tables.example';
const KEY = 'test-passkey';
let kv: FakeKV;
let env: Env;

beforeEach(() => {
  kv = new FakeKV();
  env = { TABLE: kv as unknown as KVNamespace, UPLOAD_KEY: KEY };
});

/** A real gear stamp (the deployed gear-859e… table's header). */
const GEAR = JSON.parse(readFileSync(new URL('./fixtures/gear-859e.json', import.meta.url).pathname, 'utf8'));

const HEADER = {
  version: 1,
  referenceWeek: 1799654400,
  cteBonus: 128.71,
  deliveryScore: 1,
  from: 120,
  to: 120,
  builtAt: '2026-10-21T04:22:52.116Z',
  simVersion: '0214e968',
};

const cell: Cell = {
  te: 120,
  h: 0,
  builds: [{ sales: 2, tier13: true, waitStart: 3600, saleEnd: 7200, peakELR: 1.5e13, delivered: [1e15, 2e15, 3e15, 4e15, 5e15] }],
};

function table(header: Record<string, unknown>): Uint8Array {
  return packTable({ ...HEADER, ...header } as never, [cell]);
}

async function gzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

function upload(name: string | null, body: ArrayBuffer | Uint8Array, query: Record<string, string> = {}, authed = true): Promise<Response> {
  const params = new URLSearchParams({ ...(name ? { name } : {}), ...query });
  return handle(
    new Request(`${ORIGIN}/upload${params.toString() ? `?${params}` : ''}`, {
      method: 'POST',
      headers: authed ? { Authorization: `Bearer ${KEY}` } : {},
      body,
    }),
    env,
    ctx
  );
}

const get = (path: string, method = 'GET'): Promise<Response> => handle(new Request(`${ORIGIN}${path}`, { method }), env, ctx);
const index = async () => ((await (await get('/tables/index.json')).json()) as { tables: Record<string, unknown>[] }).tables;

describe('GET /', () => {
  it('serves the upload page with the catalog link and its own name check', async () => {
    const res = await get('/');
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('/tables/index.json');
    // The browser-side name check has to arrive as valid JavaScript (a real `.bin(\.gz)?$`).
    expect(html).toContain('.bin(\\.gz)?$');
    expect(html).toContain('DecompressionStream');
  });
});

describe('GET /tables/index.json', () => {
  it('is an empty catalog before anything is uploaded', async () => {
    const res = await get('/tables/index.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await res.text()).toBe('{"tables":[]}');
  });

  it('lists a delivery table and its alias with the published fields', async () => {
    const gz = await gzip(table({ deliveryKey: '09f8b316', delivery: ['quantum-metronome-3-2', 'interstellar-compass-4-0', 'gusset-2-2', 'lunar-totem-4-3'], doubleEarnings: true }));
    const res = await upload('table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz', gz);
    expect(res.status).toBe(200);

    const tables = await index();
    expect(tables.map(t => t.name)).toEqual([
      'table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz',
      'delivery-09f8b316.bin.gz',
    ]);
    expect(Object.keys(tables[0])).toEqual([
      'name', 'kind', 'bytes', 'sha256', 'deliveryKey', 'delivery', 'from', 'to',
      'simVersion', 'builtWith', 'doubleEarnings', 'builtAt',
    ]);
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', gz));
    const hex = Array.from(sha, b => b.toString(16).padStart(2, '0')).join('');
    for (const entry of tables) {
      expect(entry).toMatchObject({
        kind: 'delivery',
        bytes: gz.byteLength,
        sha256: hex,
        deliveryKey: '09f8b316',
        from: 120,
        to: 120,
        simVersion: '0214e968',
        builtWith: null,
        doubleEarnings: true,
        builtAt: '2026-10-21T04:22:52.116Z',
      });
    }
    expect(tables[0].delivery).toEqual(['quantum-metronome-3-2', 'interstellar-compass-4-0', 'gusset-2-2', 'lunar-totem-4-3']);
  });

  it('supports HEAD', async () => {
    const res = await get('/tables/index.json', 'HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Content-Length')).toBe('{"tables":[]}'.length.toString());
  });
});

describe('GET /tables/<name>', () => {
  it('serves the gzipped bytes byte for byte under either name', async () => {
    const gz = await gzip(table({ deliveryKey: '09f8b316', delivery: ['a', 'b', 'c', 'd'] }));
    await upload('table-x-te120-489.bin.gz', gz);

    for (const name of ['table-x-te120-489.bin.gz', 'delivery-09f8b316.bin.gz']) {
      const res = await get(`/tables/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.get('Content-Length')).toBe(String(gz.byteLength));
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(gz));
    }
  });

  it('answers HEAD with the length and no body', async () => {
    const gz = await gzip(table({}));
    await upload('maxed.bin.gz', gz);
    const res = await get('/tables/maxed.bin.gz', 'HEAD');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(gz.byteLength));
    expect(await res.text()).toBe('');
  });

  it('404s an unknown name the published way', async () => {
    const res = await get('/tables/nope.bin.gz');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.text()).toBe('Not found');
  });

  it('answers paths outside the naming standard without reading KV', async () => {
    for (const path of [
      '/tables/wp-login.php',
      '/tables/not-a-table-name',
      '/tables/delivery-zzzzzzzz.bin.gz',
      '/tables/acct-123.bin.gz',
      '/tables/custom.bin.gz',
      '/tables/index.json.bak',
      '/meta/wp-login.php',
    ]) {
      kv.gets = 0;
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(kv.gets, path).toBe(0);
    }
  });

  it('reads KV once for a name that passes the standard but is not stored', async () => {
    kv.gets = 0;
    expect((await get('/tables/delivery-11112222.bin.gz')).status).toBe(404);
    expect(kv.gets).toBe(1);
  });

  it('rejects a path that is not a table name', async () => {
    expect((await get('/tables/..%2Fsecret')).status).toBe(404);
    expect((await get('/tables/index.json/../../x')).status).toBe(404);
  });

  it('404s a percent-escape that is not valid UTF-8 instead of throwing', async () => {
    for (const path of ['/tables/%E0%A4', '/meta/%E0%A4', '/meta/%E0%A4%A.bin.gz']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text()).toBe('Not found');
    }
  });

  it('405s a write method that has no route, as a read-only catalog does', async () => {
    for (const method of ['POST', 'PUT', 'PATCH']) {
      const res = await get('/tables/maxed.bin.gz', method);
      expect(res.status, method).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET, HEAD, DELETE, OPTIONS');
    }
  });
});

describe('upload', () => {
  it('needs the passkey', async () => {
    const body = table({});
    expect((await upload('maxed.bin.gz', body, {}, false)).status).toBe(401);
    const wrong = await handle(
      new Request(`${ORIGIN}/upload?name=maxed.bin.gz`, { method: 'POST', headers: { Authorization: 'Bearer nope' }, body }),
      env,
      ctx
    );
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe('wrong passkey');
    expect((await handle(new Request(`${ORIGIN}/upload`, { method: 'POST' }), { TABLE: kv as unknown as KVNamespace }, ctx)).status).toBe(500);
  });

  it('compresses an uncompressed .bin on the way in', async () => {
    const raw = table({});
    const res = await upload('maxed.bin', raw);
    expect(res.status).toBe(200);
    const [entry] = (await res.json() as { tables: { name: string; bytes: number }[] }).tables;
    expect(entry.name).toBe('maxed.bin.gz');
    expect(entry.bytes).toBeLessThan(raw.byteLength);
    expect((await get('/tables/maxed.bin.gz')).status).toBe(200);
  });

  it('registers both maxed names and keeps the planner path working', async () => {
    await upload(null, table({}));
    expect((await index()).map(t => t.name)).toEqual(['maxed.bin.gz', 'table.bin.gz']);
    const compat = await get('/table.bin.gz');
    expect(compat.status).toBe(200);
    expect(compat.headers.get('Content-Type')).toBe('application/octet-stream');
    const meta = await get('/meta');
    expect(((await meta.json()) as { kind: string }).kind).toBe('maxed');
  });

  it('takes a name, kind and builtWith when the header has none', async () => {
    const res = await upload('gear-0123456789abcdef01234567.bin.gz', table({}), { kind: 'gear', builtWith: 'someone' });
    expect(res.status).toBe(200);
    const [entry] = (await res.json() as { tables: Record<string, unknown>[] }).tables;
    expect(entry).toMatchObject({ name: 'gear-0123456789abcdef01234567.bin.gz', kind: 'gear', builtWith: 'someone' });
  });

  it('asks for a name when nothing identifies the file', async () => {
    const res = await upload(null, table({ gear: { earnings: [], deliveryBare: [] } }), { kind: 'gear' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/name is required/);
  });

  it('does not let an .asbuilt file take the delivery alias', async () => {
    const gz = await gzip(table({ deliveryKey: '09f8b316', delivery: ['a', 'b', 'c', 'd'] }));
    await upload('table-x-te120-489.bin.gz', gz);
    await upload('table-x-te120-489.asbuilt.bin.gz', gz);
    const names = (await index()).map(t => t.name);
    expect(names).toEqual([
      'table-x-te120-489.bin.gz',
      'delivery-09f8b316.bin.gz',
      'table-x-te120-489.asbuilt.bin.gz',
    ]);
  });

  it('replaces a re-uploaded table in place, keeping the published order', async () => {
    const first = await gzip(table({}));
    const second = await gzip(table({ simVersion: 'later' }));
    await upload('maxed.bin.gz', first);
    await upload('table.bin.gz', first);
    await upload('maxed.bin.gz', second);
    // `table.bin.gz` is maxed.bin.gz's alias, so the newer upload repoints both names.
    const tables = await index();
    expect(tables.map(t => t.name)).toEqual(['maxed.bin.gz', 'table.bin.gz']);
    expect(tables.every(t => t.simVersion === 'later')).toBe(true);
  });

  it('takes extra aliases from the query', async () => {
    const res = await upload('maxed.bin.gz', table({}), { aliases: 'acct-0123456789abcdef01234567.bin, delivery-11112222.bin' });
    expect(res.status).toBe(200);
    expect((await index()).map(t => t.name)).toEqual([
      'maxed.bin.gz',
      'table.bin.gz',
      'acct-0123456789abcdef01234567.bin.gz',
      'delivery-11112222.bin.gz',
    ]);
    expect((await get('/tables/delivery-11112222.bin.gz')).status).toBe(200);
  });

  it('rejects a corrupt file with a reason', async () => {
    const res = await upload('maxed.bin.gz', new TextEncoder().encode('not a table'));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('that file is not a precomputed table');
  });

  it('rejects a name with a path in it', async () => {
    expect((await upload('../maxed.bin.gz', table({}))).status).toBe(400);
  });

  it('rejects a name outside the standard, and an alias outside it too', async () => {
    expect((await upload('custom.bin.gz', table({}))).status).toBe(400);
    expect((await upload('maxed.bin.gz', table({}), { aliases: 'custom.bin.gz' })).status).toBe(400);
  });
});

describe('gear and account tables', () => {
  it('registers a gear table under the three names its stamp is looked up by', async () => {
    const res = await upload('gear-859e797bf59a848dc75d4cbf.bin.gz', table({ gear: GEAR }));
    expect(res.status).toBe(200);
    const names = (await index()).map(t => t.name);
    expect(names).toHaveLength(3);
    expect(names[0]).toBe('gear-859e797bf59a848dc75d4cbf.bin.gz');
    for (const name of names) expect(name).toMatch(/^gear-[0-9a-f]{24}\.bin\.gz$/);
    // Every name serves the same bytes.
    for (const name of names) expect((await get(`/tables/${name}`)).status).toBe(200);
  });

  it('names an unnamed gear table from its stamp', async () => {
    const res = await upload(null, table({ gear: GEAR }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { tables: { name: string }[] }).tables[0].name).toBe(
      'gear-859e797bf59a848dc75d4cbf.bin.gz'
    );
  });

  it('never registers gear names for an account table', async () => {
    const res = await upload('acct-09c7c97a50bcbe5d44eea6f7.bin.gz', table({ gear: GEAR }));
    expect(res.status).toBe(200);
    expect((await index()).map(t => t.name)).toEqual(['acct-09c7c97a50bcbe5d44eea6f7.bin.gz']);
  });

  it('does not invent names for a file whose gear stamp is incomplete', async () => {
    const res = await upload('gear-0123456789abcdef01234567.bin.gz', table({ gear: { earnings: [] } }));
    expect(res.status).toBe(200);
    expect((await index()).map(t => t.name)).toEqual(['gear-0123456789abcdef01234567.bin.gz']);
  });
});

describe('DELETE and promote', () => {
  it('deletes one alias and keeps the other, then drops the bytes with the last name', async () => {
    const gz = await gzip(table({}));
    await upload('maxed.bin.gz', gz);
    const sha = (await index())[0].sha256 as string;

    expect((await handle(new Request(`${ORIGIN}/tables/maxed.bin.gz`, { method: 'DELETE' }), env, ctx)).status).toBe(401);
    const del = await handle(new Request(`${ORIGIN}/tables/maxed.bin.gz`, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } }), env, ctx);
    expect(del.status).toBe(200);
    expect((await index()).map(t => t.name)).toEqual(['table.bin.gz']);
    expect((await get('/tables/table.bin.gz')).status).toBe(200);
    expect(kv.store.has(`blob:${sha}`)).toBe(true);

    await handle(new Request(`${ORIGIN}/tables/table.bin.gz`, { method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` } }), env, ctx);
    expect((await index())).toEqual([]);
    expect(kv.store.has(`blob:${sha}`)).toBe(false);
  });

  it('points another name at a stored file', async () => {
    await upload('maxed.bin.gz', await gzip(table({})));
    const sha = (await index())[0].sha256 as string;
    const res = await handle(
      new Request(`${ORIGIN}/promote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ name: 'delivery-11112222.bin.gz', sha256: sha }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(200);
    const entry = (await index()).find(t => t.name === 'delivery-11112222.bin.gz')!;
    expect(entry).toMatchObject({ kind: 'delivery', sha256: sha });
    expect((await get('/tables/delivery-11112222.bin.gz')).status).toBe(200);
  });

  it('404s a promote to bytes that were never stored', async () => {
    const res = await handle(
      new Request(`${ORIGIN}/promote`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ name: 'delivery-11112222.bin.gz', sha256: 'f'.repeat(64) }),
      }),
      env,
      ctx
    );
    expect(res.status).toBe(404);
  });
});
