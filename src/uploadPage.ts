/**
 * The upload page, served inline by GET /: the catalog as served, a file picker that parses
 * the table's header in the browser (so an uploader sees what will be published, and under
 * which name), and delete buttons. No framework, no assets.
 */
export const UPLOAD_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AP table store</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 900px; margin: 3rem auto; padding: 0 1rem; color: #e6e6e6; background: #14161a; }
  h1 { font-size: 1.2rem; } h2 { font-size: 1rem; margin-top: 2rem; color: #9aa0a6; }
  .card { background: #1e2128; border: 1px solid #33373f; border-radius: 8px; padding: 1rem 1.25rem; margin: .75rem 0; }
  .row { display: flex; gap: .5rem 1.25rem; flex-wrap: wrap; } .row div { min-width: 8rem; }
  .k { color: #9aa0a6; font-size: .8rem; display: block; }
  table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #2b2f36; vertical-align: top; }
  th { color: #9aa0a6; font-weight: 500; }
  input[type=text], input[type=password] { background: #14161a; color: inherit; border: 1px solid #3a3f47; border-radius: 5px; padding: .4rem .6rem; }
  input[type=file] { color: inherit; } input[type=file]::file-selector-button { background: #2d6cdf; color: #fff; border: 0; border-radius: 5px; padding: .5rem .9rem; margin-right: .8rem; cursor: pointer; }
  button { background: #2d6cdf; color: #fff; border: 0; border-radius: 5px; padding: .4rem .8rem; cursor: pointer; }
  button.ghost { background: #3a3f47; } button:disabled { background: #3a3f47; cursor: default; }
  .err { color: #ff8a80; } .ok { color: #7fd68b; } code { background: #262a32; padding: .1rem .35rem; border-radius: 4px; }
  .hidden { display: none; } .muted { color: #9aa0a6; }
</style>
</head>
<body>
<h1>AP table store</h1>
<p class="muted">Served catalog: <a href="/tables/index.json" style="color:#7fb0ff">/tables/index.json</a> &middot;
files at <code>/tables/&lt;name&gt;</code></p>

<h2>Tables</h2>
<div id="tables" class="card">loading&hellip;</div>

<h2>Upload a table</h2>
<p>Accepts <code>.bin</code> or <code>.bin.gz</code>. The header is parsed here first; nothing is sent until you confirm.</p>
<p><input type="password" id="key" placeholder="passkey (UPLOAD_KEY)" autocomplete="off" style="max-width:16rem"></p>
<p><input type="file" id="file"></p>
<p>
  <input type="text" id="name" placeholder="name (e.g. delivery-09f8b316.bin.gz)" style="min-width:22rem">
  <input type="text" id="kind" placeholder="kind (auto)" style="max-width:9rem">
</p>
<div id="preview" class="card hidden"></div>
<p><button id="upload" class="hidden">Upload</button></p>
<div id="status"></div>

<script type="module">
const FIELDS = 9, WEEK_HOURS = 168, NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\\.bin(\\.gz)?$/;
let file = null, header = null, expected = 0;

const el = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const size = n => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MiB' : Math.round(n / 1024) + ' KiB';

function kindOf(name, h) {
  const base = String(name || '').replace(/\\.gz$/, '');
  if (/^acct-[0-9a-f]{24}$/.test(base)) return 'account';
  if (/^gear-[0-9a-f]{24}$/.test(base)) return 'gear';
  if (base === 'table.bin' || base === 'maxed.bin') return 'maxed';
  if (/^delivery-[0-9a-f]{8}$/.test(base)) return 'delivery';
  if (/^table-.+$/.test(base)) return 'delivery';
  if (h && h.deliveryKey) return 'delivery';
  if (h && h.gear) return 'gear';
  return 'maxed';
}

function nameFor(h, kind) {
  if (kind === 'delivery' && h.deliveryKey) return 'delivery-' + h.deliveryKey + '.bin.gz';
  if (kind === 'maxed') return 'maxed.bin.gz';
  return '';
}

async function parse(raw) {
  let bytes = raw;
  const head = new Uint8Array(raw, 0, 2);
  if (head[0] === 0x1f && head[1] === 0x8b)
    bytes = await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const view = new DataView(bytes);
  const len = view.getUint32(0, true);
  const h = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 4, len)));
  const start = Math.ceil((4 + len) / 8) * 8;
  expected = start + (h.to - h.from + 1) * WEEK_HOURS * h.slots * FIELDS * 8;
  if (bytes.byteLength !== expected) throw new Error('incomplete table: ' + bytes.byteLength + ' of ' + expected + ' bytes');
  return h;
}

function previewRow(h, name, kind) {
  return ['<div class="row">',
    '<div><span class="k">name</span><code>' + esc(name || '—') + '</code></div>',
    '<div><span class="k">kind</span>' + esc(kind) + '</div>',
    '<div><span class="k">TE range</span>' + h.from + '–' + h.to + '</div>',
    '<div><span class="k">slots</span>' + h.slots + '</div>',
    '<div><span class="k">sim version</span>' + esc(h.simVersion || '—') + '</div>',
    '<div><span class="k">built with</span>' + esc(h.builtWith || '—') + '</div>',
    '<div><span class="k">built at</span>' + esc(h.builtAt || '—') + '</div>',
    '<div><span class="k">doubler</span>' + (h.doubleEarnings === true ? 'on' : h.doubleEarnings === false ? 'off' : '—') + '</div>',
    '<div><span class="k">delivery key</span>' + esc(h.deliveryKey || '—') + '</div>',
    '</div>'].join('');
}

function refreshPreview() {
  if (!header) return;
  const typed = el('name').value.trim();
  const kind = el('kind').value.trim() || kindOf(typed || nameFor(header), header);
  if (!typed) el('name').value = nameFor(header, kind);
  el('preview').innerHTML = previewRow(header, el('name').value.trim(), kind);
}

async function loadTables() {
  try {
    const res = await fetch('/tables/index.json', { cache: 'no-store' });
    const body = await res.json();
    const rows = (body.tables || []).map(t => ['<tr>',
      '<td><a style="color:#7fb0ff" href="/tables/' + encodeURIComponent(t.name) + '">' + esc(t.name) + '</a></td>',
      '<td>' + esc(t.kind) + '</td>',
      '<td>' + t.from + '–' + t.to + '</td>',
      '<td>' + esc(t.simVersion || '—') + '</td>',
      '<td>' + size(t.bytes) + '</td>',
      '<td><code>' + esc(t.sha256.slice(0, 12)) + '</code></td>',
      '<td><button class="ghost" data-del="' + esc(t.name) + '">delete</button></td>',
      '</tr>'].join(''));
    el('tables').innerHTML = rows.length
      ? '<table><tr><th>name</th><th>kind</th><th>TE</th><th>simulator</th><th>size</th><th>sha256</th><th></th></tr>' + rows.join('') + '</table>'
      : '<span class="muted">nothing uploaded yet</span>';
    for (const b of el('tables').querySelectorAll('[data-del]'))
      b.addEventListener('click', () => remove(b.getAttribute('data-del')));
  } catch (err) {
    el('tables').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
}

el('file').addEventListener('change', async e => {
  file = null; header = null;
  el('preview').classList.add('hidden'); el('upload').classList.add('hidden'); el('status').textContent = '';
  try {
    file = e.target.files[0];
    header = await parse(await file.arrayBuffer());
    if (!el('name').value) el('name').value = nameFor(header, kindOf('', header));
    el('preview').innerHTML = previewRow(header, el('name').value.trim(), kindOf(el('name').value.trim(), header));
    el('preview').classList.remove('hidden'); el('upload').classList.remove('hidden');
  } catch (err) {
    el('status').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
});

el('name').addEventListener('input', refreshPreview);
el('kind').addEventListener('input', refreshPreview);

el('upload').addEventListener('click', async () => {
  if (!file) return;
  const name = el('name').value.trim();
  const kind = el('kind').value.trim();
  if (name && !NAME.test(name)) return void (el('status').innerHTML = '<span class="err">not a table file name</span>');
  el('status').textContent = 'uploading…';
  try {
    const q = new URLSearchParams();
    if (name) q.set('name', name);
    if (kind) q.set('kind', kind);
    const res = await fetch('/upload' + (q.toString() ? '?' + q : ''), {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + el('key').value },
      body: file,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || res.status);
    el('status').innerHTML = '<span class="ok">stored ' + body.tables.map(t => esc(t.name)).join(', ') + '</span>';
    await loadTables();
  } catch (err) {
    el('status').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
});

async function remove(name) {
  if (!confirm('Delete ' + name + '?')) return;
  try {
    const res = await fetch('/tables/' + encodeURIComponent(name), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + el('key').value },
    });
    if (!res.ok) throw new Error((await res.json()).error || res.status);
    await loadTables();
  } catch (err) {
    el('status').innerHTML = '<span class="err">' + esc(err.message) + '</span>';
  }
}

loadTables();
</script>
</body>
</html>`;
