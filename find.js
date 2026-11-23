// CellPeek — find cells by what they are ("Ni65 graphite cells with VC"), not by barcode.
// What is searched, per cell (barcode):
//   * the rows that name the cell in the lab's cell-tracker spreadsheets (cell type, electrolyte, additives, temperature ...).
//     tools/build_tracker_rows.py writes them to cellpeek_trackers.json.gz twice a week; the backend hands the file to
//     approved users ('trackers' action) and it is kept in this browser until a newer one exists.
//   * the names of the cell's Neware files (the file index of data.js).
// A question becomes a list of terms; a term is a list of synonyms. A cell is a hit when every term is found somewhere in
// its text and no excluded term is. Terms come from the rules below at once, and from the backend's 'ask' action (Claude)
// for questions the rules cannot read; the terms are shown and can be changed, so the search is never a black box.
// Only the question and the alias list are sent to the backend for 'ask'; no cell data.
'use strict';
(function () {
const NQP = window.NQP = window.NQP || {}, C = window.NQP_CONFIG || {}, $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const MAX_SHOW = 1500, MAX_ADD = 300;

// ---------- lab alias list (label: the spellings found in trackers and file names) ----------
const ALIASES = [
  {label: 'graphite', syn: ['graphite', 'AG', 'NG', 'Gr', 'pGr', 'F1Z', 'MAG', '石墨']},
  {label: 'silicon', syn: ['Si', 'SiO', 'SiOx', 'SiC', 'NovuSi', 'NovSi', 'silicon', '硅']},
  {label: 'hard carbon', syn: ['hard carbon', 'HC', '硬碳']},
  {label: 'LFP', syn: ['LFP', 'LiFePO4', '磷酸铁锂']},
  {label: 'LMFP', syn: ['LMFP']},
  {label: 'NCA', syn: ['NCA']},
  {label: 'LCO', syn: ['LCO', 'LiCoO2', '钴酸锂']},
  {label: 'LMO', syn: ['LMO', 'LiMn2O4', '锰酸锂']},
  {label: 'LNMO', syn: ['LNMO']},
  {label: 'LNO', syn: ['LNO', 'LiNiO2']},
  {label: 'single crystal', syn: ['SC', 'single crystal', '单晶']},
  {label: 'anode-free', syn: ['anode free', 'anodefree', '无负极']},
  {label: 'half cell', syn: ['half cell', 'half', 'coin cell', 'Li metal', '半电池']},
  {label: 'sodium-ion', syn: ['Na ion', 'NaPF6', 'sodium', '钠离子', '钠电']},
];
const NI_CODE = {33: '111', 50: '532', 60: '622', 65: '640', 80: '811'};
const VOCAB = ALIASES.map(a => a.label + ': ' + a.syn.join(', ')).join('\n') +
  '\n' + Object.entries(NI_CODE).map(([n, c]) => `Ni${n}: Ni${n}, NMC${n}, NM${n}, NMC${c}, ${c}`).join('\n');
const STOP = new Set(('cell cells battery batteries all the with as additive additives and of in on show me give find that have has having using use used ' +
  'electrolyte electrolytes containing contain contains anode cathode at for a an to please list which where is are was were made electrode positive ' +
  'negative any every from data cycling cycled only').split(' '));
const CJK_STOP = /给我|帮我|所有|全部|电池|电芯|作为|做|添加剂|使用|采用|含有|含|以及|和|与|或|的|用|正极|负极|电解液|电解质|请|查找|找出|搜索|找|查|搜|里面|里|中|带有|带|加了|加|有|是|温度|电压|循环|数据|那些|哪些|这些|一下|材料|体系|只|仅/g;

// ---------- a synonym -> a regular expression (whole token, case and separators ignored) ----------
function synRx(s) {
  s = String(s || '').trim().toLowerCase().slice(0, 60); if (!s) return '';
  let out = '', prev = '';
  for (const ch of s) {
    const kind = /[a-z]/.test(ch) ? 'a' : /\d/.test(ch) ? 'd' : /[\s\-_]/.test(ch) ? 's' : 'o';
    if (kind === 's') { if (prev !== 's') out += '[\\s\\-_]*'; }
    else {
      if ((prev === 'a' && kind === 'd') || (prev === 'd' && kind === 'a')) out += '[\\s\\-_°]*';     // Ni65 = Ni 65 = Ni-65, 40C = 40 °C
      out += ch.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
    }
    prev = kind;
  }
  const a = s[0], z = s[s.length - 1];
  const pre = /[a-z]/.test(a) ? '(?<![a-z])' : /\d/.test(a) ? '(?<!\\d)(?<!\\d\\.)' : '';
  const post = /[a-z]/.test(z) ? '(?![a-z])' : /\d/.test(z) ? '(?!\\d)(?!\\.\\d)' : '';
  return pre + out + post;
}
const termRx = (t, flags = 'i') => new RegExp(t.syn.map(synRx).filter(Boolean).join('|') || '(?!)', flags);

// ---------- question -> terms (rules; no network) ----------
function termOf(tok) {
  let not = false; if (/^[-!]/.test(tok)) { not = true; tok = tok.replace(/^[-!]+/, ''); }
  if (!tok || tok.length > 40) return null;
  const low = tok.toLowerCase(); let m;
  if (STOP.has(low)) return null;
  if ((m = low.match(/^(?:ni|nmc|nm)-?(\d{2})$/)) || ((m = low.match(/^(?:nmc|nm)?-?(111|532|622|640|811)$/)) && (m = [0, Object.keys(NI_CODE).find(k => NI_CODE[k] === m[1])]))) {
    const n = m[1], c = NI_CODE[n], syn = [`Ni${n}`, `NMC${n}`, `NM${n}`]; if (c) syn.push('NMC' + c, c);
    return {label: 'Ni' + n, syn, not};
  }
  if ((m = low.match(/^(\d{2})c$/))) return {label: m[1] + ' °C', syn: [m[1] + 'C', m[1] + ' degC', m[1] + '℃'], not};
  if ((m = low.match(/^(\d)\.(\d{1,2})v$/))) return {label: `${m[1]}.${m[2]} V`, syn: [`${m[1]}.${m[2]}V`, `${m[1]}${m[2]}V`], not};
  const al = ALIASES.find(a => a.label.toLowerCase() === low || a.syn.some(x => x.toLowerCase() === low));
  if (al) return {label: al.label, syn: al.syn.slice(), not};
  return {label: tok, syn: [tok], not, lit: true};
}
function parseRules(q) {
  let s = ' ' + q + ' ';
  s = s.replace(/[，。；、？！,;?!()（）"“”']/g, ' ');
  s = s.replace(/无负极|anode[\s-]*free/gi, ' anodefree ').replace(/single[\s-]*crystal/gi, ' SC ').replace(/half[\s-]*cells?/gi, ' half ').replace(/hard[\s-]*carbon/gi, ' HC ');
  s = s.replace(/(不含有|不含|没有|不要|不带|不加|不用|无)\s*/g, ' -').replace(/(^|\s)(?:without|no|not|excluding|except)\s+/gi, ' -');
  s = s.replace(/(\d{2})\s*(?:°\s*c|℃|度|deg\s*c)(?![a-z])/gi, '$1C ').replace(/(\d{2})\s+c(?![a-z\d])/gi, '$1C ').replace(/(\d\.\d{1,2})\s+v(?![a-z])/gi, '$1V ');
  s = s.replace(CJK_STOP, ' ').replace(/([一-鿿]+)/g, ' $1 ').replace(/-\s+/g, '-');
  const out = [];
  for (const tok of s.split(/\s+/)) {
    const t = termOf(tok); if (!t) continue;
    const same = out.find(x => x.label === t.label && x.not === t.not); if (!same) out.push(t);
  }
  return out;
}
const needsAI = (q, terms) => /[一-鿿]/.test(q) || q.trim().split(/\s+/).length >= 4 || /\b(only|except|other than|but not)\b/i.test(q) ||
  terms.some(t => t.lit && /^[a-z]{5,}$/.test(t.label));

// ---------- tracker rows ----------
const T = {p: null, d: null, err: '', t: 0};
const b64bytes = (b) => { const s = atob(b), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function loadTrackers() {
  return T.p || (T.p = (async () => {
    let rec = NQP.idb ? await NQP.idb.get('trk').catch(() => null) : null;       // {t_file, gz}
    try {
      if (C.APPS_SCRIPT_URL && NQP.call) {
        const j = await NQP.call('trackers', {have: rec ? rec.t_file : ''});
        if (j.gz) { rec = {t_file: j.t_file, gz: b64bytes(j.gz)}; NQP.idb && NQP.idb.set('trk', rec).catch(() => {}); }
        else if (j.none) rec = null;
      } else if (!C.APPS_SCRIPT_URL) {                                           // no login configured (testing): a file next to the page
        const r = await fetch('cellpeek_trackers.json.gz'); if (r.ok) rec = {t_file: 'local', gz: new Uint8Array(await r.arrayBuffer())};
      }
    } catch (e) { if (!rec) { T.err = e.message; T.p = null; return null; } }    // offline or old backend: keep the saved copy
    if (!rec) { T.err = 'no tracker file on the server'; return null; }
    const txt = await new Response(new Blob([rec.gz]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    const j = JSON.parse(txt), rows = j.rows, scope = new Array(rows.length), byCell = new Map();
    for (let i = 0; i < rows.length; i++) { const r = rows[i];
      scope[i] = r[4] + ' ¦ ' + r[5] + ' ¦ ' + j.files[r[0]][0] + ' ¦ ' + r[1];
      for (const bc of r[6]) { let a = byCell.get(bc); if (!a) byCell.set(bc, a = []); a.push(i); } }
    T.d = {files: j.files, headers: j.headers, rows, scope, byCell}; T.t = j.t; T.err = '';
    return T.d;
  })());
}

// ---------- Neware file names per cell ----------
const primaryBc = (f) => { const m = f.match(/(?<!\d)\d{7}(?!\d)/) || f.match(/(?<!\d)\d{4,9}(?!\d)/); return m ? m[0] : null; };
let NW = null;
function nwIndex() {
  if (NW) return NW;
  const m = new Map();
  if (NQP.index && NQP.index.all) for (const [name] of NQP.index.all()) { const bc = primaryBc(name); if (!bc) continue;
    let a = m.get(bc); if (!a) m.set(bc, a = []); a.push(name); }
  return (NW = m);
}

// ---------- search ----------
const S = {q: '', terms: [], hits: [], groups: [], checked: new Set(), stamp: 0, edited: false, ai: '', aiErr: '', note: '', last: null, n1: 0};
const AI = {off: false, fails: 0};
function search() {
  const D = T.d, nw = nwIndex(), pos = S.terms.filter(t => !t.not), neg = S.terms.filter(t => t.not);
  S.hits = []; S.groups = []; S.n1 = 0;
  if (!pos.length) return;
  const match = (t) => { const rx = termRx(t), rowHit = D ? new Uint8Array(D.rows.length) : null, cellsHit = new Set(), byName = new Map();
    if (D) for (let i = 0; i < D.scope.length; i++) if (rx.test(D.scope[i])) { rowHit[i] = 1; for (const bc of D.rows[i][6]) cellsHit.add(bc); }
    for (const [bc, names] of nw) { const n = names.find(x => rx.test(x)); if (n) { cellsHit.add(bc); byName.set(bc, n); } }
    return {rowHit, cellsHit, byName}; };
  const P = pos.map(match), N = neg.map(match);
  const small = P.reduce((a, b) => (a.cellsHit.size <= b.cellsHit.size ? a : b));
  const groups = new Map();
  for (const bc of small.cellsHit) {
    if (!P.every(p => p.cellsHit.has(bc)) || N.some(n => n.cellsHit.has(bc))) continue;
    let best = -1, bestN = 0;
    if (D) for (const i of D.byCell.get(bc) || []) { let n = 0; for (const p of P) n += p.rowHit[i];
      if (n > bestN || (n === bestN && n > 0 && best >= 0 && D.rows[best][7] && !D.rows[i][7])) { best = i; bestN = n; } }
    const strong = bestN === P.length, name = (P.find(p => p.byName.has(bc)) || {byName: new Map()}).byName.get(bc) || (nw.get(bc) || [])[0] || '';
    const h = {bc, row: bestN ? best : -1, strong, name, hasData: nw.size ? nw.has(bc) : true};
    if (strong) S.n1++;
    const key = h.row >= 0 ? D.rows[h.row][0] : -1;
    let g = groups.get(key); if (!g) groups.set(key, g = {key, hits: [], strong: 0}); g.hits.push(h); g.strong += strong ? 1 : 0;
  }
  const gs = [...groups.values()];
  for (const g of gs) g.hits.sort(g.key < 0 ? (a, b) => b.bc.localeCompare(a.bc, undefined, {numeric: true})
    : (a, b) => String(D.rows[a.row][1]).localeCompare(String(D.rows[b.row][1])) || D.rows[a.row][2] - D.rows[b.row][2]);
  gs.sort((a, b) => (a.key < 0) - (b.key < 0) || b.strong - a.strong || b.hits.length - a.hits.length);
  S.groups = gs; S.hits = gs.flatMap(g => g.hits);
}

// ---------- drawing ----------
const added = () => new Set(NQP.cellsApi ? NQP.cellsApi.list().map(c => c.bc) : []);
function hl(text, rx) {                          // escape + mark the matched words
  let out = '', k = 0; rx.lastIndex = 0;
  for (const m of text.matchAll(rx)) { if (!m[0]) continue; out += esc(text.slice(k, m.index)) + '<mark>' + esc(m[0]) + '</mark>'; k = m.index + m[0].length; }
  return out + esc(text.slice(k));
}
const ago = (ms) => { const s = (Date.now() - ms) / 1000; return s < 5400 ? Math.round(s / 60) + ' min ago' : s < 129600 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' d ago'; };
function render() {
  const box = $('#askbox'); if (!box) return;
  if (!S.q) { box.hidden = true; return; }
  box.hidden = false;
  $('#askterms').innerHTML = S.terms.map((t, i) => `<span class="trm${t.not ? ' not' : ''}" data-i="${i}" title="${esc((t.not ? 'Excluded: ' : 'Any of: ') + t.syn.join(', '))} — click to change">${t.not ? 'not ' : ''}${esc(t.label)}<a href="#" title="Remove">✕</a></span>`).join('') +
    `<a href="#" id="askplus" title="Add a term">+ term</a>`;
  const D = T.d, n = S.hits.length, more = n > MAX_SHOW;
  const info = [];
  info.push(`${n.toLocaleString()} cell${n === 1 ? '' : 's'}` + (S.n1 && S.n1 < n ? ` · ${S.n1.toLocaleString()} with every term in one tracker row` : '') + (more ? ` · showing the first ${MAX_SHOW}` : ''));
  if (S.checked.size) info.push(`${S.checked.size} selected`);
  if (S.ai === 'asking') info.push('reading the question…');
  else if (S.ai === 'done') info.push('terms read by AI' + (S.note ? ': ' + S.note : ''));
  else if (S.ai === 'failed') info.push('AI reading failed (' + S.aiErr + '); built-in rules used');
  if (!D) info.push(T.p && !T.err ? 'loading the cell trackers…' : 'cell trackers not available' + (T.err ? ' (' + T.err + ')' : '') + ': Neware file names only');
  else info.push(`trackers: ${D.rows.length.toLocaleString()} rows, ${ago(T.t)}`);
  if (!nwIndex().size) info.push('connect the CYCLING folder (top right) to load cells');
  $('#askinfo').textContent = info.join(' · ');
  const have = added(), pos = S.terms.filter(t => !t.not);
  const rx = pos.length ? new RegExp(pos.map(t => t.syn.map(synRx).filter(Boolean).join('|')).filter(Boolean).join('|') || '(?!)', 'gi') : /(?!)/g;
  let html = '', shown = 0, i = 0;
  for (const g of S.groups) {
    if (shown >= MAX_SHOW) break;
    const f = g.key >= 0 ? D.files[g.key] : null, fname = f ? f[0].split('\\').pop() : '';
    html += `<div class="grp" data-g="${S.groups.indexOf(g)}"><b>${f ? esc(f[1]) : 'Neware file names'}</b><span title="${f ? esc(f[0]) + ' · ' + esc(f[2]) : 'These cells are not named in a tracker row that matches; the terms were found in the names of their Neware files'}">${f ? esc(fname) : 'no matching tracker row'} · ${g.hits.length} cell${g.hits.length === 1 ? '' : 's'}</span><a href="#">select these</a></div>`;
    for (const h of g.hits) { const idx = i++; if (shown >= MAX_SHOW) continue; shown++;
      const on = have.has(h.bc), r = h.row >= 0 ? D.rows[h.row] : null;
      // shown: the cells of the row without the empty ones and the plain decimals (weights, thicknesses); the tooltip has the whole row
      const text = r ? r[4].split(' | ').filter(v => v && !/^-?\d*\.\d+$/.test(v) && v !== h.bc).join(' | ') : h.name.replace(/\.txt$/i, '');
      const tip = r ? `${D.headers[r[3]] || ''}\n${r[4]}\n${D.files[r[0]][0]} · sheet ${r[1]} · row ${r[2]}` : h.name;
      const meta = (on ? 'added · ' : '') + (r ? (r[5] ? esc(r[5].slice(0, 40)) + ' · ' : '') + (h.strong ? '' : 'other terms in another row or file name · ') + (r[7] ? 'barcode read from the row · ' : '') + 'row ' + r[2]
        : '') + (h.hasData ? '' : ' · no Neware file');
      html += `<div class="row${on ? ' added' : S.checked.has(h.bc) ? ' sel' : ''}${h.hasData ? '' : ' nodata'}" data-i="${idx}" title="${esc(tip)}"><span class="bc">${esc(h.bc)}</span><span class="tx">${hl(text, rx)}</span><span class="mt">${meta}</span></div>`; }
  }
  if (!n) html = `<div class="none">${pos.length ? 'No cell has all of these terms. Remove a term (✕) or click a term to add other spellings.' : 'Type what the cells should have, e.g. Ni65 graphite VC.'}</div>`;
  const list = $('#asklist'), top = list.scrollTop; list.innerHTML = html; list.scrollTop = top;
  $('#askadd').textContent = `Add selected${S.checked.size ? ' (' + S.checked.size + ')' : ''}`;
}
let runT;
function rerun(now) { clearTimeout(runT); runT = setTimeout(() => { search(); render(); }, now ? 0 : 120); }

// ---------- asking ----------
async function askAI(q, stamp) {
  if (!C.APPS_SCRIPT_URL || !NQP.call || AI.off) return;
  S.ai = 'asking'; render();
  try {
    const j = await NQP.call('ask', {q, vocab: VOCAB});
    if (stamp !== S.stamp) return;
    if (j.none) { AI.off = true; S.ai = ''; }
    else {
      AI.fails = 0;
      const terms = (j.terms || []).map(t => ({label: String(t.label || '').slice(0, 40), not: !!t.exclude, ai: true,
        syn: (t.synonyms || []).map(x => String(x).trim().slice(0, 60)).filter(Boolean).slice(0, 16)})).filter(t => t.label && t.syn.length);
      if (terms.length && !S.edited) { S.terms = terms; S.note = String(j.note || '').slice(0, 200); S.ai = 'done'; S.checked.clear(); search(); }
      else S.ai = '';
    }
  } catch (e) { if (stamp !== S.stamp) return; S.ai = 'failed'; S.aiErr = e.message.slice(0, 80); if (++AI.fails >= 2) AI.off = true; }
  render();
}
function start(q) {
  q = q.trim(); S.q = q; S.stamp++; S.edited = false; S.ai = ''; S.note = ''; S.checked.clear(); S.last = null;
  if (!q) { S.terms = []; return render(); }
  S.terms = parseRules(q);
  const stamp = S.stamp;
  loadTrackers().then(() => { if (stamp === S.stamp) rerun(true); });
  rerun(true);
  if (needsAI(q, S.terms)) askAI(q, stamp);
  NQP.log && NQP.log('find');
}
function editTerm(i, chip) {                     // click a term: change its spellings in place ("-" in front = exclude)
  const t = S.terms[i] || {label: '', syn: [], not: false}, inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'trmedit'; inp.value = (t.not ? '-' : '') + t.syn.join(', ');
  inp.placeholder = 'spellings, separated by commas'; inp.title = 'Any of these spellings counts. Put - in front to exclude cells that have it. Enter to apply, Esc to cancel.';
  chip.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const apply = (ok) => { if (done) return; done = true;
    if (ok) { let v = inp.value.trim(); const not = /^[-!]/.test(v); v = v.replace(/^[-!]+\s*/, '');
      const syn = v.split(/[,，;；]+/).map(x => x.trim()).filter(Boolean);
      if (syn.length) { const nt = {label: t.label && syn.includes(t.syn[0]) ? t.label : syn[0], syn, not}; i < S.terms.length ? S.terms[i] = nt : S.terms.push(nt); }
      else if (i < S.terms.length) S.terms.splice(i, 1);
      S.edited = true; S.stamp++; if (S.ai === 'asking') S.ai = ''; S.checked.clear(); search(); }
    render(); };
  inp.onkeydown = e => { if (e.key === 'Enter') apply(true); else if (e.key === 'Escape') { e.stopPropagation(); apply(false); } };
  inp.onblur = () => apply(true);
}

// ---------- wiring ----------
NQP.find = {render: () => { if (S.q) render(); }, _parse: parseRules, _rx: synRx, _state: S, _trackers: T};
function init() {
  const inp = $('#ask'); if (!inp) return;
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') start(inp.value); else if (e.key === 'Escape') { inp.value = ''; start(''); } });
  inp.addEventListener('input', () => { if (!inp.value.trim()) start(''); });
  if ($('#askgo')) $('#askgo').onclick = () => { start(inp.value); inp.focus(); };           // for people who do not press Enter
  inp.addEventListener('focus', () => { loadTrackers().catch(() => {}); }, {once: true});
  $('#askterms').addEventListener('click', e => { e.preventDefault();
    if (e.target.id === 'askplus') return editTerm(S.terms.length, e.target);
    const chip = e.target.closest('.trm'); if (!chip) return; const i = +chip.dataset.i;
    if (e.target.tagName === 'A') { S.terms.splice(i, 1); S.edited = true; S.stamp++; if (S.ai === 'asking') S.ai = ''; S.checked.clear(); search(); render(); }
    else editTerm(i, chip); });
  $('#asklist').addEventListener('click', e => {
    const have = added(), ok = h => h && !have.has(h.bc) && h.hasData;
    const g = e.target.closest('.grp');
    if (g) { e.preventDefault(); if (e.target.tagName !== 'A') return;
      for (const h of S.groups[+g.dataset.g].hits) if (ok(h)) S.checked.add(h.bc); return render(); }
    const row = e.target.closest('.row'); if (!row) return; const i = +row.dataset.i, h = S.hits[i]; if (!ok(h)) return;
    if (e.shiftKey && S.last != null) { for (let k = Math.min(i, S.last); k <= Math.max(i, S.last); k++) if (ok(S.hits[k])) S.checked.add(S.hits[k].bc); }
    else S.checked.has(h.bc) ? S.checked.delete(h.bc) : S.checked.add(h.bc);
    S.last = i; render(); });
  $('#askselall').onclick = () => { const have = added(); S.hits.slice(0, MAX_SHOW).forEach(h => { if (!have.has(h.bc) && h.hasData) S.checked.add(h.bc); }); render(); };
  $('#asknone').onclick = () => { S.checked.clear(); render(); };
  $('#askclose').onclick = () => { inp.value = ''; start(''); };
  $('#askadd').onclick = () => {
    const bcs = [...S.checked]; if (!bcs.length || !NQP.cellsApi) return;
    const st = $('#status');
    if (bcs.length > MAX_ADD) { if (st) st.textContent = `${bcs.length} cells selected; at most ${MAX_ADD} can be added at once.`; return; }
    NQP.cellsApi.add(bcs.join(' ')); S.checked.clear(); render(); };
  window.addEventListener('nqp-index', () => { NW = null; if (S.q) rerun(); });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
