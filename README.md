# AP table store

A Cloudflare Worker + KV store for the ascension planner's precomputed instant-answer
tables, serving them the way the published catalog does
(`https://aaap-tables.williamthe5thc.workers.dev/tables/index.json`, release
`delivery-tables-2026-10-21`).

Reads vastly outnumber writes. A catalog read is one KV get (`index`); a file read is
one KV get (`entry:<name>`) plus one blob get (`blob:<sha256>`), edge-cached.

## The catalog

```
GET /tables/index.json   {"tables":[...]}   public, max-age=300
GET /tables/<name>       the .bin.gz         public, max-age=3600
```

One index line per **served file name**, in the order tables were first uploaded:

```json
{
  "name": "delivery-09f8b316.bin.gz",
  "kind": "delivery",
  "bytes": 3181357,
  "sha256": "2aac6d87…",
  "deliveryKey": "09f8b316",
  "delivery": ["quantum-metronome-3-2", "interstellar-compass-4-0", "gusset-2-2", "lunar-totem-4-3"],
  "from": 120,
  "to": 489,
  "simVersion": "0214e968",
  "builtWith": null,
  "doubleEarnings": true,
  "builtAt": "2026-10-21T04:22:52.116Z"
}
```

`bytes` and `sha256` describe the file **as served** — the gzipped bytes, not the
unpacked table. `kind` is one of `maxed`, `account`, `gear`, `delivery`. Fields a header
does not carry are `null` (the maxed table has no `builtWith` and no `doubleEarnings`).

## Names and aliases

The name families are the released tables' (`src/catalog.ts`):

| Name | Kind | Aliases |
|---|---|---|
| `maxed.bin.gz` | maxed | `table.bin.gz` (the planner's `precompute/table.bin`) |
| `acct-<24 hex>.bin.gz` | account | — |
| `gear-<24 hex>.bin.gz` | gear | — |
| `table-<built name>-te120-489.bin.gz` | delivery | `delivery-<deliveryKey>.bin.gz` |
| `delivery-<deliveryKey>.bin.gz` | delivery | — |

An `.asbuilt` variant of a delivery table is stored under its own name and does **not**
take the `delivery-<key>` alias — the refreshed table keeps it. A gear table that names a
`deliveryKey` in its header stays a gear table and gets no alias (the published index does
the same for `gear-859e…`).

`kind` comes from the name first; `?kind=` overrides it, and the header decides when the
name says nothing (`deliveryKey` → delivery, `gear` → gear).

## Writing

```sh
# stored as uploaded when the file is .gz; compressed here when it is not
curl -X POST --data-binary @table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz \
  -H "Authorization: Bearer $UPLOAD_KEY" \
  "https://<worker>/upload?name=table-metronome-T3E_compass-T4C_gusset-T2E-te120-489.bin.gz"
```

| Route | What it does |
|---|---|
| `POST /upload[?name=&kind=&builtWith=&aliases=]` | Body = the file's raw bytes. Validates (`src/validate.ts`), stores it under the name (or `delivery-<key>.bin.gz` / `maxed.bin.gz`), registers its aliases. Answers `{"tables":[entries]}`. |
| `POST /promote` | `{"name":"…","sha256":"…"}` — point a name at a file already stored (rollback, or publish a table under a name it was not uploaded as). |
| `DELETE /tables/<name>` | Drop that name. The bytes go when no name still uses them. |
| `GET /meta`, `GET /meta/<name>` | One index entry. `GET /meta` is the maxed table's. |
| `GET /table.bin.gz` | The maxed table at its old path, for clients built before `/tables/`. |
| `GET /` | Upload page: the catalog, a file picker that parses the header in the browser, and delete buttons. |

`UPLOAD_KEY` gates every write (`npx wrangler secret put UPLOAD_KEY`; `.dev.vars`
locally). Without it set, writes answer 500 instead of allowing anonymous uploads. The
check compares SHA-256 digests, not the strings.

## Storage layout

| Key | Value |
|---|---|
| `index` | the whole `/tables/index.json` body, so a catalog read is one get |
| `entry:<name>` | that name's index line, so a file read is one get plus one blob get |
| `blob:<sha256>` | the gzipped bytes, shared by every alias of the same file |
| `template:<sha256>` | the index line the file was first uploaded with, for `POST /promote` |

Writes keep the index in place: a re-uploaded name replaces its line where it stands, a
new name is appended, so the published order only grows. Aliases are repointed by the
latest upload of a table with that key — uploading `maxed.bin.gz` again also updates
`table.bin.gz`.

## Validation

`src/validate.ts` ports the planner's `readTable` checks: gzip-or-raw magic, header JSON
(`version: 1`, `slots > 0`, a TE range, an 8-hex `deliveryKey` when present), the **exact
expected byte length** (`(to−from+1) × 168 × slots × 9 × 8`), and a spot decode of the
first non-empty cell. A gzip bomb is cut off at 64 MiB unpacked. Invalid uploads get a
400 with the reason and nothing is written.

## Deploy

```sh
npm install
npx wrangler kv namespace create TABLE   # then paste the id into wrangler.toml
npm run deploy
```

Population: open the deployed URL and upload each file, or POST it as above. A table
replaces a name in place, so a rebuild is another upload.

## Local dev & tests

```sh
npm run dev      # wrangler dev on :8787, local KV simulation
npm test         # vitest: the catalog rules, the worker's routes on a fake KV, validation
```

## Notes

- KV is eventually consistent (~60 s worst case globally after a write); fine, since
  writes are rare. Edge cache is purged on every write, for the index, the changed names
  and `/table.bin.gz`.
- The 25 MiB KV value ceiling is the design's real limit: if a table ever approaches
  ~24 MB gzipped, move `blob:` to R2 and keep the entries in KV. The read path would not
  change.
