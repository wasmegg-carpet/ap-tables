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
| `gear-<24 hex>.bin.gz` | gear | the stamp's canonical v3, v2 and legacy names (§ below) |
| `table-<built name>-te120-489.bin.gz` | delivery | `delivery-<deliveryKey>.bin.gz` |
| `delivery-<deliveryKey>.bin.gz` | delivery | — |

An `.asbuilt` variant of a delivery table is stored under its own name and does **not**
take the `delivery-<key>` alias — the refreshed table keeps it. A gear table that names a
`deliveryKey` in its header stays a gear table and gets no alias (the published index does
the same for `gear-859e…`).

`kind` comes from the name first; `?kind=` overrides it, and the header decides when the
name says nothing (`deliveryKey` → delivery, `gear` → gear).

### Gear and account names (ported from AutoAutoAP)

`src/gear.ts` is AutoAutoAP's `src/search/tableGear.ts`, so a table is reachable under whichever
name the page works out from a save:

- **`gear-<24 hex>.bin.gz`** is the first 12 bytes of SHA-256 of a table header's gear stamp, in
  one of three forms: **v3** (sets as worn, only the modelled epic research and the colleggtible
  *effects*), **v2** (the save's own research/colleggtible maps, under `v: 2`) and **legacy**
  (the stamp exactly as worn, without its `research` map). A `gear-` upload registers all three;
  the page tries v3, then v2, then legacy. Verified against the deployed tables: the port
  reproduces `gear-859e…`, `gear-67b3…`, `gear-9146…` and `gear-b8c9…` as their v3 names.
- **`acct-<24 hex>.bin.gz`** is PBKDF2-SHA256 of the player id (`tableName`). The store never sees
  the id — pass the name at upload, or call `tableName` in the page. An `acct-` table is **never**
  registered under its gear names: it is one account's own simulation, and its gear is not a
  secret, so a gear alias would hand one player's table to everyone wearing the same gear.
- **A nameless gear upload names itself** from its stamp (the v3 name). An account table cannot.

The two data tables in `src/gear.ts` (22 modelled epic research ids, 13 colleggtibles with their
tier values) come from AutoAutoAP's `lib/epicResearch.ts` and `lib/collegtibles.ts` and **change
the hash**: a new colleggtible or epic research entry renames every gear table. Update them
together with AutoAutoAP, then republish.

**The allowlist.** Only those names are served — and only those are accepted at upload, so
nothing can be stored under a name that would 404. Anything else is answered `404` after a
character check of the raw path and a shape check, **before** the path is decoded or KV is
read: a scanner poking at `/tables/wp-login.php`, `/tables/delivery-zzzzzzzz.bin.gz` or
`/tables/../../../etc` costs no KV operation at all (`catalog.ts` `isNameChars`,
`isServedName`). A name that passes the shape but was never uploaded costs one small
`entry:` read. A new naming family is a change in `catalog.ts`, deliberately.

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
400 with the reason and nothing is written, and a name outside the allowlist is refused
before any of that.

## Deploy

```sh
npm install
npx wrangler kv namespace create TABLE   # then paste the id into wrangler.toml
npm run deploy
```

Population: open the deployed URL and upload each file, or POST it as above. A table
replaces a name in place, so a rebuild is another upload.

## Publishing a release

Two scripts do the whole release (`npx vite-node`, no build step):

```sh
# 1. download the release's files and check them against the worker's own rules
gh release download delivery-tables-2026-10-21 --repo william-egginc/AutoAutoAP --pattern '*.bin.gz'
npx vite-node scripts/preflight-release.ts -- ./delivery-tables-2026-10-21      # add --asbuilt to include those

# 2. write the catalog (blobs and entries first, `index` last so it appears whole), then verify
npx vite-node scripts/publish-release.ts -- --dir ./delivery-tables-2026-10-21 \
  --account <ACCOUNT_ID> --namespace <KV_NAMESPACE_ID> --base https://<worker>
```

`--dry-run` prints the names, kinds, aliases and the catalog body without writing. Add
`--asbuilt` to publish the release's `.asbuilt.bin.gz` copies too (they get their own names
and no `delivery-<key>` alias). The publisher uses `CLOUDFLARE_API_TOKEN`, else the OAuth
token wrangler is logged in with, and writes the same records `POST /upload` writes.

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
