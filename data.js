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
// Design (0.2.3): a file index.
//   * Every NEWARE folder (CC_NEWAREB12A, NEWARE and the folders inside them) is listed once, several folders at a
//     time, and the lists are saved in this browser. From them a barcode -> file map is built.
//   * A lookup is a map lookup + opening that one file by name. No folder is read when a cell is loaded,
//     and dQ/dV reuses the file already found.
//   * The main folders are listed again in the background when the list is older than 30 min (other folders: 1 day),
//     or when a single barcode is not in the index (a newly exported cell); it is loaded the moment its name is read.
const PV = 5;                                    // parser version (parser.js PARSER_VERSION)
const STALL_MS = 120000;                         // a folder read that delivers nothing for this long is reported as not responding
const PAR = 4;                                   // folders read at the same time
const MAIN_AGE = 30 * 60000, SUB_AGE = 24 * 3600000, FRESH = 15000, SRV_AGE = 14 * 3600000;
const emit = () => { try { window.dispatchEvent(new CustomEvent('nqp-index')); } catch {} };
const bcsOf = (n) => { const m = n.match(/\d+/g) || [], out = []; for (const x of m) if (x.length >= 4 && x.length <= 9 && !out.includes(x)) out.push(x); return out; };
const isTxt = (n) => /\.txt$/i.test(n);
const local = {
  root: null, roots: [], subs: [], handles: new Map(), lists: new Map(), scans: new Map(), idx: new Map(),
  picks: new Map(), mem: new Map(), workers: null, jobs: new Map(), jobId: 0, running: 0, queue: [], showAll: false, timer: null,
  async resolveRoots(h) {                        // CYCLING -> NEWARE/CC_NEWAREB12A + NEWARE; NEWARE -> its CC_NEWAREB12A + itself; else itself
    const sub = async (d, n) => { try { return await d.getDirectoryHandle(n); } catch { return null; } };
    let neware = h.name.toUpperCase() === 'NEWARE' ? h : await sub(h, 'NEWARE');
    if (!neware) return [h];
    const cc = await sub(neware, 'CC_NEWAREB12A');
    return cc ? [cc, neware] : [neware];
  },
  key(name) { return 'ls:' + (this.root ? this.root.name : '') + '/' + name; },
  isRoot(name) { return this.roots.some(r => r.name === name); },
  async use(h) {
    clearTimeout(this.timer);
    this.root = h; this.subs = []; this.roots = await this.resolveRoots(h);
    this.handles.clear(); this.lists.clear(); this.idx.clear(); this.picks.clear();
    for (const r of this.roots) this.handles.set(r.name, {h: r});
    await Promise.all(this.roots.map(r => this.cached(r.name)));              // saved lists: the index is ready at once
    this.findSubs();
    await Promise.all(this.subs.map(n => this.cached(n)));
    this.rebuild();
    emit();
    this.ready = this.pull().then(ok => { if (!ok) this.selfUpdate(); }, () => this.selfUpdate());
  },
  // Index built twice a day on the office PC (tools/build_index.py -> Drive -> Apps Script action 'index').
  // Folders in it replace the saved lists when they are newer. Returns true if a usable index was there.
  async pull() {
    if (!NQP.call) return false;
    const root = this.root, have = await idb.get('srv:' + root.name).catch(() => null);
    const j = await NQP.call('index', {have: have ? have.t_file : ''});
    if (root !== this.root) return true;
    if (j.same) { this.srv = have; }
    else if (j.folders) {
      const t = +j.t || Date.now();
      for (const [name, f] of Object.entries(j.folders)) {
        const key = this.key(name), rec = this.lists.get(key);
        if (rec && rec.t >= t) continue;                           // the browser read this folder more recently
        const items = (f.files || []).map(n => [n, 'file']).concat((f.dirs || []).map(n => [n, 'directory']));
        const nr = {t, items, srv: true}; this.lists.set(key, nr); idb.set(key, nr).catch(() => {});
        if (!this.isRoot(name) && !this.handles.has(name) && f.parent) this.handles.set(name, {parent: f.parent});
      }
      this.srv = {t, t_file: j.t_file, host: j.host, ms: j.ms};
      idb.set('srv:' + root.name, this.srv).catch(() => {});
      this.findSubs(); this.rebuild(); emit();
      NQP.log && NQP.log('index_pull', {t, files: this.count(), host: j.host});
    } else return false;
    return Date.now() - this.srv.t < SRV_AGE;                      // too old (office PC off?): the browser keeps it up to date itself
  },
  selfUpdate() {                                 // no fresh index from the office PC: read the folders in the browser
    const stale = (n, age) => { const rec = this.lists.get(this.key(n)); return !rec || Date.now() - rec.t > age; };
    const first = this.roots.some(r => !this.lists.get(this.key(r.name)));
    if (first) return this.build();                                            // no index yet: build it now
    this.timer = setTimeout(() => {                                            // index there: update quietly a little later
      for (const r of this.roots) if (stale(r.name, MAIN_AGE)) this.scan(r.name);
      for (const n of this.subs) if (stale(n, SUB_AGE)) this.scan(n);
    }, 15000);
  },
  build(all = true) {                            // list every folder again (main folders first)
    this.indexT0 = Date.now();
    for (const r of this.roots) this.scan(r.name);
    if (all) for (const n of this.subs) this.scan(n);
  },
  findSubs() {                                   // folders inside the main folders (from their lists)
    for (const r of this.roots) {
      const rec = this.lists.get(this.key(r.name)); if (!rec) continue;
      for (const [n, k] of rec.items) if (k === 'directory' && !this.isRoot(n) && !this.subs.includes(n)) {
        this.subs.push(n); if (!this.handles.has(n)) this.handles.set(n, {parent: r.name});
      }
    }
  },
  async dir(name) {                              // folder handle by name (opened on first use)
    const e = this.handles.get(name); if (!e) throw new Error('unknown folder ' + name);
    if (!e.p) e.p = e.h ? Promise.resolve(e.h) : this.dir(e.parent).then(d => d.getDirectoryHandle(name));
    try { return await e.p; } catch (err) { e.p = null; throw err; }
  },
  async cached(name) {
    const key = this.key(name); let rec = this.lists.get(key);
    if (!rec) { rec = await idb.get(key).catch(() => null); if (rec) this.lists.set(key, rec); }
    return rec || null;
  },
  add(folder, name) { for (const bc of bcsOf(name)) { let a = this.idx.get(bc); if (!a) this.idx.set(bc, a = []);
    if (!a.some(x => x[0] === folder && x[1] === name)) a.push([folder, name]); } },
  rebuild() {                                    // barcode -> [[folder, file]] from all saved lists (+ reads in progress)
    const t0 = performance.now(); this.idx.clear();
    for (const n of [...this.roots.map(r => r.name), ...this.subs]) for (const [f, k] of this.names(n)) if (k === 'file' && isTxt(f)) this.add(n, f);
    this.idxMs = Math.round(performance.now() - t0);
  },
  async slot() { if (this.running < PAR) { this.running++; return; } await new Promise(r => this.queue.push(r)); this.running++; },
  free() { this.running--; const r = this.queue.shift(); if (r) r(); },
  scan(name) {                                   // one read per folder at a time, shared by every lookup
    const key = this.key(name); let s = this.scans.get(key); if (s) return s;
    s = {name, items: [], subs: new Set(), t0: Date.now(), started: false};
    s.done = (async () => {
      const prio = this.isRoot(name);
      if (!prio) await this.slot();              // main folders never wait for a slot
      s.started = true; s.t0 = Date.now(); emit();
      let last = Date.now(), tm, fail;
      try {
        const d = await this.dir(name);
        const stall = new Promise((_, rej) => { fail = rej; });
        tm = setInterval(() => { if (Date.now() - last > STALL_MS) fail(new Error(`folder ${name} is not responding`)); }, 5000);
        const read = (async () => {
          let n = 0;
          for await (const [f, e] of d.entries()) {
            const it = [f, e.kind]; s.items.push(it); last = Date.now();
            if (it[1] === 'file' && isTxt(f)) this.add(name, f);
            for (const cb of s.subs) cb(it);
            if (++n % 1000 === 0) emit();
          }
        })();
        await Promise.race([read, stall]);
      } finally { clearInterval(tm); if (!prio) this.free(); }
      const rec = {t: Date.now(), items: s.items}; this.lists.set(key, rec);
      idb.set(key, rec).catch(() => {});
      NQP.log && NQP.log('list', {dir: name, n: s.items.length, ms: Date.now() - s.t0});
      return s.items;
    })().finally(() => {
      this.scans.delete(key);
      if (this.isRoot(name)) { const before = this.subs.length; this.findSubs();
        for (const n of this.subs.slice(before)) this.scan(n); }              // new folders inside a main folder
      this.rebuild();                                                         // drop files that are gone
      if (!this.scans.size && this.indexT0) { NQP.log && NQP.log('index', {files: this.count(), folders: this.roots.length + this.subs.length, ms: Date.now() - this.indexT0}); this.indexT0 = 0; }
      emit();
    });
    s.done.catch(() => {});
    this.scans.set(key, s); emit();
    return s;
  },
  refresh(maxAge = 0, all = false) {             // read the folders again if their list is older than maxAge
    if (!this.root) return;
    if (maxAge === 0 && !this.scans.size) this.indexT0 = Date.now();
    for (const n of [...this.roots.map(r => r.name), ...(all ? this.subs : [])]) {
      const rec = this.lists.get(this.key(n));
      if (!this.scans.has(this.key(n)) && (!rec || Date.now() - rec.t > maxAge)) this.scan(n);
    }
  },
  names(name) {                                  // what is known right now: saved list + anything a running read has seen
    const rec = this.lists.get(this.key(name)), s = this.scans.get(this.key(name));
    if (!s || !s.items.length) return rec ? rec.items : [];
    if (!rec) return s.items;
    const seen = new Set(s.items.map(x => x[0])), out = s.items.slice();
    for (const it of rec.items) if (!seen.has(it[0])) out.push(it);
    return out;
  },
  count() { let n = 0; for (const a of this.idx.values()) n += a.length; return n; },
  status() {
    const all = [...this.roots.map(r => r.name), ...this.subs];
    let n = 0; for (const f of all) for (const [x, k] of this.names(f)) if (k === 'file' && isTxt(x)) n++;
    const ts = this.roots.map(r => (this.lists.get(this.key(r.name)) || {}).t || 0);
    const sc = [...this.scans.values()];
    return {connected: !!this.root, srv: this.srv && Date.now() - this.srv.t < SRV_AGE ? this.srv : null, scanning: sc.length > 0, building: ts.some(t => !t), left: sc.length,
      folders: all.length, n, t: ts.length && Math.min(...ts) || null,
      secs: sc.length ? Math.round((Date.now() - Math.min(...sc.map(s => s.t0))) / 1000) : 0};
  },
  match: (bc, n) => isTxt(n) && new RegExp('(?<!\\d)' + bc + '(?!\\d)').test(n),
  lookup(bc) { return (this.idx.get(bc) || []).slice(); },
  waitFor(bc, rescan) {                          // wait for running reads (and, if rescan, read the main folders again)
    return new Promise((res) => {
      const hits = [], subs = []; let left = 0, settled = false;
      const finish = () => { if (settled) return; settled = true; subs.forEach(([s, f]) => s.subs.delete(f)); res(hits); };
      const watch = (s) => {
        left++;
        const f = ([n, k]) => { if (k === 'file' && this.match(bc, n)) { hits.push([s.name, n]); setTimeout(finish, 0); } };
        for (const it of s.items) f(it);
        s.subs.add(f); subs.push([s, f]);
        s.done.then(() => {}, () => {}).then(() => { if (!--left) finish(); });
      };
      if (rescan) for (const r of this.roots) {
        const rec = this.lists.get(this.key(r.name));
        if (!this.scans.has(this.key(r.name)) && !(rec && Date.now() - rec.t < FRESH)) this.scan(r.name);
      }
      for (const s of this.scans.values()) watch(s);
      if (!left) finish();
    });
  },
  async find(bc, rescan = true) {
    if (!this.root) throw new Error('no data folder: click "connect CYCLING folder" (top right)');
    if (this.ready) await this.ready;            // first visit: wait for the office-PC index instead of reading folders
    let hits = this.lookup(bc), out = hits.length ? await this.stat(hits) : [];
    if (!out.length) {                           // not in the index (or files gone): new export?
      hits = await this.waitFor(bc, rescan);
      hits = hits.concat(this.lookup(bc));
      out = await this.stat(hits);
    }
    return out;
  },
  async stat(hits) {
    const out = [], seen = new Set();
    await Promise.all(hits.map(async ([folder, n]) => { if (seen.has(n)) return; seen.add(n);
      try { const fh = await (await this.dir(folder)).getFileHandle(n), f = await fh.getFile();
        out.push({name: n, dir: folder, size: f.size, mtime: f.lastModified, fh}); } catch {} }));
    out.sort((a, b) => b.size - a.size);         // largest first (empty stubs / partial exports last)
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
  let pick = u.pathname === '/api/vq' && q.file && local.picks.get(bc + '|' + q.file), files = null;   // dQ/dV: reuse the file found for the cell
  if (!pick) {
    files = await local.find(bc, q.deep !== '0');
    if (!files.length) throw new Error(`${bc} not found`);
    pick = files.find(f => f.name === q.file) || files[0];
    for (const f of files) local.picks.set(bc + '|' + f.name, f);
  }
  const d = await local.data(pick);
  if (u.pathname === '/api/cell') {
    NQP.log && NQP.log('cell', {bc, file: pick.name, cycles: d.cycles.length, ms: Math.round(performance.now() - t0)});
    return {barcode: bc, file: pick.name, dir: pick.dir, size: pick.size, mtime: pick.mtime, candidates: (files || [pick]).map(f => f.name), fmt: d.fmt, offset: d.offset, start: d.start, parse_s: d.parse_s, cycles: d.cycles};
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
  async forget() { await idb.del('cycling').catch(() => {}); local.root = null; local.roots = []; local.subs = []; local.idx.clear(); local.picks.clear(); },
  name: () => local.root ? local.root.name : '',
  refresh: (maxAge, all) => local.refresh(maxAge, all),
  roots: () => local.roots.map(r => r.name),
};
// file index: what the page's search box and status line use
NQP.index = {
  status: () => local.status(),
  files() {                                    // [{name, dir}] for every .txt in the main folders (+ the other folders if asked)
    const out = [], seen = new Set();
    const add = (f) => { for (const [n, k] of local.names(f)) if (k === 'file' && isTxt(n) && !seen.has(n)) { seen.add(n); out.push({name: n, dir: f}); } };
    for (const r of local.roots) add(r.name);
    if (local.showAll) for (const f of local.subs) add(f);
    return out;
  },
  async readAll() { local.showAll = true; for (const f of local.subs) if (!(await local.cached(f))) local.scan(f); emit(); },
  candidates(bc) { return [...new Set(local.lookup(bc).map(x => x[1]))]; },
};
document.addEventListener('visibilitychange', () => {        // back to the tab: newer office-PC index? else read the main folders if old
  if (document.visibilityState !== 'visible' || !local.root) return;
  if (local.srv && Date.now() - (local.pulled || 0) < 30 * 60000) return;
  local.pulled = Date.now();
  local.pull().then(ok => { if (!ok) local.refresh(MAIN_AGE); }, () => local.refresh(MAIN_AGE));
});
NQP._useHandle = async (h) => { await local.use(h); await idb.set('cycling', h); };   // used by the automated test only
NQP.clearCache = async () => { await idb.clear('cache'); localStorage.removeItem('nqp_cache_order'); local.mem.clear(); };
})();
