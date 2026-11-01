/**
 * Pre-flight for publishing a GitHub release's tables: validate every file in a directory with
 * the worker's own checks and print the name, kind and aliases an upload would give it.
 *
 *   npx vite-node scripts/preflight-release.ts -- /path/to/release/files [--asbuilt]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { aliasesOf, kindOf, servedName } from '../src/catalog';
import { validateTable } from '../src/validate';

const dir = process.argv[2];
if (!dir) throw new Error('usage: preflight-release.ts -- <dir> [--asbuilt]');
const includeAsBuilt = process.argv.includes('--asbuilt');

const files = readdirSync(dir)
  .filter(f => f.endsWith('.bin.gz') && (includeAsBuilt || !f.includes('.asbuilt')))
  .sort();

let bad = 0;
for (const file of files) {
  const name = servedName(basename(file));
  const raw = readFileSync(join(dir, file));
  const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  try {
    const v = await validateTable(bytes);
    const kind = kindOf(name, v.header);
    const aliases = await aliasesOf(name, v.header);
    console.log(
      `${name}\n  kind=${kind} bytes=${v.bytes} sha256=${v.sha256.slice(0, 12)}… ` +
        `TE ${v.header.from}-${v.header.to} sim=${v.header.simVersion} key=${v.header.deliveryKey ?? '-'}` +
        `${aliases.length ? ` aliases=${aliases.join(',')}` : ''}`
    );
  } catch (err) {
    bad++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${files.length} files, ${bad} failed`);
process.exit(bad ? 1 : 0);
