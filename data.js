// CellPeek — data access. Provides window.api(path) with the same answers as server.py's /api/* endpoints.
// Three sources:
//   local  : the user's own CYCLING folder, opened read-only in the browser (Chrome / Edge); parsing in a Web Worker
//   remote : super users only — server.py on the office PC through Tailscale (URL + token)
//   server : the page itself is served by server.py (old local mode)
// The data folder is only ever opened with mode 'read'; this page cannot write to it.
'use strict';
(function () {
const NQP = window.NQP = window.NQP || {};

// ---------- tiny IndexedDB key-value store ----------
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('nqp', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('cache'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store); const r = fn(s);
    t.oncomplete = () => res(r && 'result' in r ? r.result : undefined); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); }); };
  return {
    get: (k, store = 'kv') => tx(store, 'readonly', s => s.get(k)),
    set: (k, v, store = 'kv') => tx(store, 'readwrite', s => s.put(v, k)),
    del: (k, store = 'kv') => tx(store, 'readwrite', s => s.delete(k)),
    keys: (store) => tx(store, 'readonly', s => s.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', s => s.clear()),
  };
})();
NQP.idb = idb;

// ---------- local folder source ----------
const PV = 4;                                    // parser version (parser.js PARSER_VERSION)
const local = {
  root: null, roots: [], lists: new Map(), mem: new Map(), worker: null, jobs: new Map(), jobId: 0,
  async resolveRoots(h) {                        // CYCLING -> NEWARE/CC_NEWAREB12A + NEWARE; NEWARE -> its CC_NEWAREB12A + itself; else itself
    const sub = async (d, n) => { try { return await d.getDirectoryHandle(n); } catch { return null; } };
    let neware = h.name.toUpperCase() === 'NEWARE' ? h : await sub(h, 'NEWARE');
    if (!neware) return [h];
    const cc = await sub(neware, 'CC_NEWAREB12A');
    return cc ? [cc, neware] : [neware];
  },
  async use(h) { this.root = h; this.roots = await this.resolveRoots(h); this.lists.clear(); },
  async list(d, force) {                         // directory listing, cached 10 min (memory) and across visits (IndexedDB)
    const key = d.name + '|' + (d === this.root ? 'root' : ''), hit = this.lists.get(d);
    if (hit && !force && Date.now() - hit.t < 600000) return hit.items;
    if (!force && !hit) { const saved = await idb.get('ls:' + this.root.name + '/' + d.name).catch(() => null);
      if (saved && Date.now() - saved.t < 600000) { this.lists.set(d, saved); return saved.items; } }
    const items = [];
    for await (const [name, e] of d.entries()) items.push([name, e.kind]);
    const rec = {t: Date.now(), items}; this.lists.set(d, rec);
    idb.set('ls:' + this.root.name + '/' + d.name, rec).catch(() => {});
    return items;
  },
  match: (bc, n) => n.toLowerCase().endsWith('.txt') && new RegExp('(?<!\\d)' + bc + '(?!\\d)').test(n),
  async find(bc) {
    if (!this.root) throw new Error('no data folder connected');
    let hits = [];
    for (const force of [false, true]) {
      for (const d of this.roots) for (const [n, k] of await this.list(d, force)) if (k === 'file' && this.match(bc, n)) hits.push([d, n]);
      if (hits.length) break;
    }
    if (!hits.length) for (const r of this.roots) for (const [n, k] of await this.list(r)) {
      if (k !== 'directory' || this.roots.some(x => x.name === n)) continue;
      const d = await r.getDirectoryHandle(n);
      for (const [m, kk] of await this.list(d)) if (kk === 'file' && this.match(bc, m)) hits.push([d, m]);
    }
    const out = [], seen = new Set();
    for (const [d, n] of hits) { if (seen.has(n)) continue; seen.add(n);
      try { const fh = await d.getFileHandle(n), f = await fh.getFile(); out.push({name: n, size: f.size, mtime: f.lastModified, fh}); } catch {} }
    out.sort((a, b) => b.size - a.size);         // largest first (empty stubs / partial exports last)
    return out;
  },
  parseInWorker(file) {
    if (!this.worker) { this.worker = new Worker('parser.js');
      this.worker.onmessage = (ev) => { const j = this.jobs.get(ev.data.id); if (!j) return; this.jobs.delete(ev.data.id);
        ev.data.error ? j.rej(new Error(ev.data.error)) : j.res(ev.data.data); }; }
    const id = ++this.jobId;
    return new Promise((res, rej) => { this.jobs.set(id, {res, rej}); this.worker.postMessage({id, file}); });
  },
  async data(pick) {
    const key = `${pick.name}|${pick.size}|${pick.mtime}|${PV}`;
    if (this.mem.has(key)) { const d = this.mem.get(key); this.mem.delete(key); this.mem.set(key, d); return d; }
    let d = await idb.get(key, 'cache').catch(() => null);
    if (d) { d.parse_s = null; }
    else {
      d = await this.parseInWorker(await pick.fh.getFile());
      idb.set(key, d, 'cache').then(() => this.trimCache()).catch(() => {});
    }
    this.mem.set(key, d); while (this.mem.size > 24) this.mem.delete(this.mem.keys().next().value);
    return d;
  },
  async trimCache() {                            // keep the newest 60 parsed files
    const ks = await idb.keys('cache'); if (ks.length <= 60) return;
    const order = JSON.parse(localStorage.getItem('nqp_cache_order') || '[]').filter(k => ks.includes(k));
    for (const k of ks) if (!order.includes(k)) order.push(k);
    while (order.length > 60) await idb.del(order.shift(), 'cache');
    localStorage.setItem('nqp_cache_order', JSON.stringify(order));
  },
};

// ---------- the api() used by the page ----------
const src = {mode: 'local', base: '', token: ''};
NQP.source = src;
async function http(url) {
  const r = await fetch(url); let j; try { j = await r.json(); } catch { throw new Error('bad answer from server (' + r.status + ')'); }
  if (!r.ok) throw new Error(j.error || r.statusText); return j;
}
window.api = async function (path) {
  const u = new URL(path, 'http://x'), q = Object.fromEntries(u.searchParams), t0 = performance.now();
  if (src.mode !== 'local') {
    const tok = src.token ? (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(src.token) : '';
    return http((src.mode === 'remote' ? src.base.replace(/\/+$/, '') : '.') + path + tok);
  }
  if (u.pathname === '/api/info') return {roots: local.roots.map(r => r.name), remote: false};
  const bc = (q.bc || '').trim();
  if (!/^\d{4,9}$/.test(bc)) throw new Error('barcode must be 4-9 digits');
  const files = await local.find(bc);
  if (!files.length) throw new Error(`${bc} not found`);
  const pick = files.find(f => f.name === q.file) || files[0];
  const d = await local.data(pick);
  if (u.pathname === '/api/cell') {
    NQP.log && NQP.log('cell', {bc, file: pick.name, cycles: d.cycles.length, ms: Math.round(performance.now() - t0)});
    return {barcode: bc, file: pick.name, candidates: files.map(f => f.name), fmt: d.fmt, offset: d.offset, start: d.start, parse_s: d.parse_s, cycles: d.cycles};
  }
  if (u.pathname === '/api/vq') {
    const ks = (q.cycles || '').split(',').filter(x => /^\d+$/.test(x)).map(Number).slice(0, 200), out = {}, off = d.offset;
    for (const k of ks) { const e = {}, c = (d.vq[k] || {}).chg, dd = (d.vq[k + off] || {}).dis_raw;
      if (c) e.chg = c; if (dd) e.dis = dd; if (c || dd) out[k] = e; }
    return {barcode: bc, vq: out};
  }
  throw new Error('not found');
};

// ---------- folder connection (first visit: pick; later: remembered) ----------
NQP.folder = {
  supported: () => 'showDirectoryPicker' in window,
  async saved() { return idb.get('cycling').catch(() => null); },
  async state() {                              // 'none' | 'prompt' | 'granted'
    const h = await this.saved(); if (!h) return 'none';
    try { return await h.queryPermission({mode: 'read'}); } catch { return 'none'; }
  },
  async reconnect() {                          // must be called from a click
    const h = await this.saved(); if (!h) return false;
    if ((await h.requestPermission({mode: 'read'})) !== 'granted') return false;
    await local.use(h); return true;
  },
  async pick() {                               // must be called from a click
    const h = await window.showDirectoryPicker({id: 'nqp-cycling', mode: 'read'});
    await local.use(h);
    await idb.set('cycling', h);
    return {name: h.name, roots: local.roots.map(r => r.name)};
  },
  async useSaved() { const h = await this.saved(); if (h) await local.use(h); return !!h; },
  async forget() { await idb.del('cycling').catch(() => {}); local.root = null; local.roots = []; },
  name: () => local.root ? local.root.name : '',
  roots: () => local.roots.map(r => r.name),
};
NQP._useHandle = async (h) => { await local.use(h); await idb.set('cycling', h); };   // used by the automated test only
NQP.clearCache = async () => { await idb.clear('cache'); localStorage.removeItem('nqp_cache_order'); local.mem.clear(); };
})();
