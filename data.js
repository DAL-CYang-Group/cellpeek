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
const STALL_MS = 120000;                         // a folder read that delivers nothing for this long is reported as not responding
const emit = () => { try { window.dispatchEvent(new CustomEvent('nqp-index')); } catch {} };
const local = {
  root: null, roots: [], lists: new Map(), scans: new Map(), mem: new Map(), workers: null, jobs: new Map(), jobId: 0,
  async resolveRoots(h) {                        // CYCLING -> NEWARE/CC_NEWAREB12A + NEWARE; NEWARE -> its CC_NEWAREB12A + itself; else itself
    const sub = async (d, n) => { try { return await d.getDirectoryHandle(n); } catch { return null; } };
    let neware = h.name.toUpperCase() === 'NEWARE' ? h : await sub(h, 'NEWARE');
    if (!neware) return [h];
    const cc = await sub(neware, 'CC_NEWAREB12A');
    return cc ? [cc, neware] : [neware];
  },
  async use(h) {
    this.root = h; this.roots = await this.resolveRoots(h); this.lists.clear();
    await Promise.all(this.roots.map(d => this.cached(d)));                     // last saved file list, for instant lookups
    this.refresh(0);                                                           // and read the folders again in the background
    emit();
  },
  key(d) { return 'ls:' + (this.root ? this.root.name : '') + '/' + d.name; },
  async cached(d) {                              // last complete listing {t, items} from memory or IndexedDB, or null
    const key = this.key(d); let rec = this.lists.get(key);
    if (!rec) { rec = await idb.get(key).catch(() => null); if (rec) this.lists.set(key, rec); }
    return rec || null;
  },
  // Reading a big folder on the network drive is slow in the browser (CC_NEWAREB12A: ~11,000 files, ~60 s).
  // So: one streaming read per folder at a time, shared by every lookup; each lookup is answered the moment its
  // file name streams past; the finished list is saved and reused, and refreshed in the background.
  scan(d) {
    const key = this.key(d); let s = this.scans.get(key); if (s) return s;
    s = {dir: d, items: [], subs: new Set(), t0: Date.now()};
    s.done = (async () => {
      let last = Date.now(), tm, fail;
      const stall = new Promise((_, rej) => { fail = rej; });
      tm = setInterval(() => { if (Date.now() - last > STALL_MS) fail(new Error(`folder ${d.name} is not responding`)); }, 5000);
      const read = (async () => {
        let n = 0;
        for await (const [name, e] of d.entries()) {
          const it = [name, e.kind]; s.items.push(it); last = Date.now();
          for (const f of s.subs) f(it);
          if (++n % 500 === 0) emit();
        }
      })();
      try { await Promise.race([read, stall]); } finally { clearInterval(tm); }
      const rec = {t: Date.now(), items: s.items}; this.lists.set(key, rec);
      idb.set(key, rec).catch(() => {});
      NQP.log && NQP.log('list', {dir: d.name, n: s.items.length, ms: Date.now() - s.t0});
      return s.items;
    })().finally(() => { this.scans.delete(key); emit(); });
    s.done.catch(() => {});
    this.scans.set(key, s); emit();
    return s;
  },
  refresh(maxAge = 0) {                          // background re-read of the main folders if their list is older than maxAge
    if (!this.root) return;
    for (const d of this.roots) {
      const rec = this.lists.get(this.key(d));
      if (!this.scans.has(this.key(d)) && (!rec || Date.now() - rec.t > maxAge)) this.scan(d);
    }
  },
  async list(d) {                                // listing of a folder: saved one if any, else read it now
    const rec = await this.cached(d); if (rec) return rec.items;
    return this.scan(d).done;
  },
  names(d) {                                     // what is known right now: saved list + anything a running read has seen
    const rec = this.lists.get(this.key(d)), s = this.scans.get(this.key(d));
    if (!s) return rec ? rec.items : [];
    if (!rec) return s.items;
    const seen = new Set(s.items.map(x => x[0])), out = s.items.slice();
    for (const it of rec.items) if (!seen.has(it[0])) out.push(it);
    return out;
  },
  status() {
    const n = this.roots.reduce((a, d) => a + this.names(d).length, 0);
    const ts = this.roots.map(d => (this.lists.get(this.key(d)) || {}).t || 0);
    return {connected: !!this.root, scanning: this.roots.some(d => this.scans.has(this.key(d))), n, t: ts.length && Math.min(...ts) || null};
  },
  match: (bc, n) => n.toLowerCase().endsWith('.txt') && new RegExp('(?<!\\d)' + bc + '(?!\\d)').test(n),
  waitFor(bc) {                                  // read the main folders again; resolve as soon as a file for bc shows up
    return new Promise((res) => {
      const hits = [], subs = [];
      let left = this.roots.length, settled = false;
      const finish = () => { if (settled) return; settled = true; subs.forEach(([s, f]) => s.subs.delete(f)); res(hits); };
      for (const d of this.roots) {
        const rec = this.lists.get(this.key(d)), running = this.scans.has(this.key(d));
        if (!running && rec && Date.now() - rec.t < 15000) { if (!--left) finish(); continue; }   // just read: no point reading again
        const s = this.scan(d);
        const f = ([n, k]) => { if (k === 'file' && this.match(bc, n)) { hits.push([d, n]); setTimeout(finish, 0); } };
        for (const it of s.items) f(it);
        s.subs.add(f); subs.push([s, f]);
        s.done.then(() => {}, () => {}).then(() => { if (!--left) finish(); });
      }
      if (!this.roots.length) finish();
    });
  },
  async find(bc, deep = true) {
    if (!this.root) throw new Error('no data folder: click "connect CYCLING folder" (top right)');
    const consider = (d, items, hits) => { for (const [n, k] of items) if (k === 'file' && this.match(bc, n)) hits.push([d, n]); };
    let hits = [];
    for (const d of this.roots) consider(d, this.names(d), hits);              // 1. saved list (instant)
    if (!hits.length) hits = await this.waitFor(bc);                            // 2. new file: wait for it to stream past
    if (!hits.length && deep) for (const r of this.roots) for (const [n, k] of await this.list(r)) {   // 3. other NEWARE folders
      if (k !== 'directory' || this.roots.some(x => x.name === n)) continue;
      const d = await r.getDirectoryHandle(n);
      consider(d, await this.list(d), hits);
    }
    return this.stat(hits);
  },
  async stat(hits) {
    const out = [], seen = new Set();
    await Promise.all(hits.map(async ([d, n]) => { if (seen.has(n)) return; seen.add(n);
      try { const fh = await d.getFileHandle(n), f = await fh.getFile(); out.push({name: n, dir: d.name, size: f.size, mtime: f.lastModified, fh}); } catch {} }));
    out.sort((a, b) => b.size - a.size);         // largest first (empty stubs / partial exports last)
    return out;
  },
  async subdirs() {                              // other NEWARE folders (for "search all folders")
    const out = [];
    for (const r of this.roots) for (const [n, k] of this.names(r)) if (k === 'directory' && !this.roots.some(x => x.name === n)) {
      try { out.push(await r.getDirectoryHandle(n)); } catch {} }
    return out;
  },
  parseInWorker(file) {                          // up to 4 workers, so several files parse at the same time
    if (!this.workers) { const n = Math.min(4, navigator.hardwareConcurrency || 2);
      this.workers = Array.from({length: n}, () => { const w = new Worker('parser.js');
        w.onmessage = (ev) => { const j = this.jobs.get(ev.data.id); if (!j) return; this.jobs.delete(ev.data.id);
          ev.data.error ? j.rej(new Error(ev.data.error)) : j.res(ev.data.data); }; return w; }); }
    const id = ++this.jobId, w = this.workers[id % this.workers.length];
    return new Promise((res, rej) => { this.jobs.set(id, {res, rej}); w.postMessage({id, file}); });
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
  const files = await local.find(bc, q.deep !== '0');
  if (!files.length) throw new Error(`${bc} not found`);
  const pick = files.find(f => f.name === q.file) || files[0];
  const d = await local.data(pick);
  if (u.pathname === '/api/cell') {
    NQP.log && NQP.log('cell', {bc, file: pick.name, cycles: d.cycles.length, ms: Math.round(performance.now() - t0)});
    return {barcode: bc, file: pick.name, dir: pick.dir, size: pick.size, mtime: pick.mtime, candidates: files.map(f => f.name), fmt: d.fmt, offset: d.offset, start: d.start, parse_s: d.parse_s, cycles: d.cycles};
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
  refresh: (maxAge) => local.refresh(maxAge),
  roots: () => local.roots.map(r => r.name),
};
// file-name index: what the page's search box and status line use
NQP.index = {
  status: () => local.status(),
  files() {                                    // [{name, dir}] for every .txt in the main folders (+ other folders once read)
    const out = [], seen = new Set();
    const add = (d, items) => { for (const [n, k] of items) if (k === 'file' && /\.txt$/i.test(n) && !seen.has(n)) { seen.add(n); out.push({name: n, dir: d.name}); } };
    for (const d of local.roots) add(d, local.names(d));
    for (const d of local.extra || []) add(d, local.names(d));
    return out;
  },
  async readAll() {                            // also read the other NEWARE folders (slow the first time)
    const ds = await local.subdirs(); local.extra = ds;
    for (const d of ds) if (!(await local.cached(d))) local.scan(d);
    emit();
  },
  candidates(bc) { const out = []; for (const d of local.roots) for (const [n, k] of local.names(d)) if (k === 'file' && local.match(bc, n)) out.push(n); return out; },
};
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') local.refresh(10 * 60000); });
NQP._useHandle = async (h) => { await local.use(h); await idb.set('cycling', h); };   // used by the automated test only
NQP.clearCache = async () => { await idb.clear('cache'); localStorage.removeItem('nqp_cache_order'); local.mem.clear(); };
})();
