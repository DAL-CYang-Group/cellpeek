// CellPeek — NMC XPS tab (made from the Raman Fitting tab; the two files are independent).
// Left: all loaded spectra, stacked (despike, background, charge correction there), with the fitted peaks drawn on each curve.
// Right: fitting window for the selected spectrum. Differences from Raman:
//   - x axis = binding energy (eV), drawn from high to low
//   - background: Shirley (iterative) or linear, between the two ends of the spectrum or of a typed window
//   - peaks: Gaussian–Lorentzian sum (pseudo-Voigt); a peak can have a spin-orbit partner (doublet) with fixed splitting and area ratio
//   - no rule presets yet
// Every change is a step in the history (Undo / Redo); the project is auto-saved in the browser and,
// if a save folder is chosen, to CellPeek_XPS_project.json in that folder.
'use strict';
(function () {
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const LN2 = Math.LN2;
const SPEC_COL = ['#1f5fbf', '#d62728', '#2ca02c', '#ff7f0e', '#9467bd', '#8c564b', '#e377c2', '#17becf', '#7f7f7f', '#bcbd22'];
const PEAK_COL = ['#2ca02c', '#1f77b4', '#d62728', '#ff7f0e', '#9467bd', '#7f7f7f', '#8c564b', '#e377c2', '#17becf', '#bcbd22'];
const idb = () => window.NQP && NQP.idb;

// ---------------- state ----------------
// DATA: raw arrays (never changed);  S: everything the user changes (snapshotted for undo)
let DATA = {};
let S = {spectra: [], sel: null, wf: {offset: 1, norm: true, view: 'corrected', fits: true}, shiftTarget: 284.8};
let HIST = [], HPOS = -1;                      // HIST[i] = {s: JSON of S, label, t}
let FITOPEN = false, PICK = false;             // fitting panel shown? · picking shift points on the waterfall?
const mode = () => !FITOPEN ? 'off' : (cur() && cur().fit.range ? 'fit' : 'range');
const VIEW = {wf: null, fit: {}};              // x zoom (not part of history)
let ACTIVE = null;                             // id of the peak last touched
let uid = Date.now() % 1e6;
const nid = () => (++uid).toString(36);

const cur = () => S.spectra.find(s => s.id === S.sel) || null;
// Two spectra belong to the same region (core level) when their energy ranges overlap by more than half of the longer one.
function sameRegion(a, b) {
  const A = DATA[a.id], B = DATA[b.id]; if (!A || !B) return false;
  const a0 = A.x[0], a1 = A.x[A.x.length - 1], b0 = B.x[0], b1 = B.x[B.x.length - 1];
  return Math.min(a1, b1) - Math.max(a0, b0) > 0.5 * Math.max(a1 - a0, b1 - b0);      // of the longer one: a survey scan is not in the region of a narrow scan
}
const inRegion = s => { const c = cur(); return !c || s === c || sameRegion(s, c); };
const regionSpectra = () => S.spectra.filter(inRegion);
let LASTSEL = null;
function autoRange(sp) {                        // keeps the fitting range on the whole (charge-corrected) spectrum while fit.auto is set
  const d = DATA[sp.id]; if (!d || !sp.fit.auto) return;
  const sh = sp.shiftOn ? +sp.shift || 0 : 0; sp.fit.range = [d.x[0] + sh, d.x[d.x.length - 1] + sh];
}
function newSpec(name, id) {
  return {id, name, color: SPEC_COL[S.spectra.length % SPEC_COL.length], show: true,
    despike: {on: false, thr: 40}, bg: {method: 'none', kind: 'shirley', navg: 3, a: null, b: null, cuts: [], applied: false}, zero: {on: false, mode: 'auto', a: 0, b: 0}, shift: 0, shiftOn: false,
    fit: {range: null, peaks: [], ratios: [], rule: 'manual', weight: null}};
}

// ---------------- history ----------------
function commit(label) {
  HIST = HIST.slice(0, HPOS + 1);
  HIST.push({s: JSON.stringify(S), label, t: new Date().toISOString()});
  if (HIST.length > 400) HIST.shift();
  HPOS = HIST.length - 1;
  render(); autosave();
}
function jump(i) {
  if (i < 0 || i >= HIST.length) return;
  HPOS = i; S = JSON.parse(HIST[i].s);
  if (!cur() && S.spectra.length) S.sel = S.spectra[0].id;
  render(); autosave();
}
const undo = () => HPOS > 0 && jump(HPOS - 1);
const redo = () => HPOS < HIST.length - 1 && jump(HPOS + 1);

// ---------------- file parsing ----------------
function parseTxt(text) {
  const x = [], y = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/[\s,;]+/); if (t.length < 2) continue;
    const a = parseFloat(t[0]), b = parseFloat(t[1]);
    if (isFinite(a) && isFinite(b)) { x.push(a); y.push(b); }
  }
  if (x.length < 5) throw new Error('no two-column data found');
  if (x[0] > x[x.length - 1]) { x.reverse(); y.reverse(); }
  return {x, y};
}
// PHI MultiPak .spe (VersaProbe): text header between SOFH and EOFH, then binary data.
//   header   SpectralRegDef: <no> <no> <name> <Z> <points> <step eV> <start eV> <end eV> … <dwell s> <pass energy eV> …   one line per region
//   binary   4 × uint32 (group, number of traces, bytes of all trace headers, 16), then one 96-byte header per trace:
//            uint32[5] = number of points, 4 chars at 72 = 'f4' | 'f8', uint32 at 76 = bytes of data, at 80 = offset of the data from the start of the binary part
// Intensities are counts per second; the energy axis is rebuilt from start and step. Returns [{region, x[], y[]}] with x ascending.
function parseSpe(buf) {
  const b = new Uint8Array(buf), find = t => { for (let i = 0; i + t.length <= b.length; i++) { let k = 0; while (k < t.length && b[i + k] === t.charCodeAt(k)) k++; if (k === t.length) return i; } return -1; };
  const e = find('EOFH'); if (find('SOFH') !== 0 || e < 0) throw new Error('not a PHI .spe file');
  let hdr = ''; for (let i = 0; i < e; i++) hdr += String.fromCharCode(b[i]);
  const regs = hdr.split(/\r?\n/).filter(l => l.startsWith('SpectralRegDef:')).map(l => { const t = l.slice(15).trim().split(/\s+/); return {name: t[2], n: +t[4], step: +t[5], start: +t[6]}; });
  if (!regs.length) throw new Error('no spectral regions in the header');
  let o = e + 4; while (b[o] === 13 || b[o] === 10) o++;
  const dv = new DataView(b.buffer, b.byteOffset + o, b.length - o), nTr = dv.getUint32(4, true), per = nTr ? dv.getUint32(8, true) / nTr : 0;
  if (!nTr || per < 84 || 16 + nTr * per > dv.byteLength) throw new Error('unexpected binary layout');
  const out = [];
  for (let k = 0; k < nTr; k++) { const h = 16 + k * per, n = dv.getUint32(h + 20, true), f8 = dv.getUint8(h + 72) === 102 && dv.getUint8(h + 73) === 56, off = dv.getUint32(h + 80, true), w = f8 ? 8 : 4;
    if (!n || off + n * w > dv.byteLength) throw new Error('trace ' + (k + 1) + ' is cut off');
    let r = regs[k % regs.length]; if (r.n !== n) r = regs.find(q => q.n === n); if (!r) throw new Error('trace ' + (k + 1) + ' matches no region of the header');
    const x = new Array(n), y = new Array(n);
    for (let i = 0; i < n; i++) { x[i] = +(r.start + i * r.step).toFixed(4); y[i] = f8 ? dv.getFloat64(off + i * 8, true) : dv.getFloat32(off + i * 4, true); }
    if (x[0] > x[n - 1]) { x.reverse(); y.reverse(); }
    out.push({region: r.name + (nTr > regs.length ? ' #' + (Math.floor(k / regs.length) + 1) : ''), x, y}); }
  return out;
}
async function addFiles(files) {
  let n = 0, last = null; const bad = [];
  for (const f of files) {
    if (/\.json$/i.test(f.name)) { try { loadProject(JSON.parse(await f.text())); } catch (e) { bad.push(f.name + ': ' + e.message); } continue; }
    try {
      const base = f.name.replace(/\.(txt|csv|dat|xy|asc|spe)$/i, '');
      const list = /\.spe$/i.test(f.name) ? parseSpe(await f.arrayBuffer()).map(t => ({name: t.region + ' · ' + base, d: {x: t.x, y: t.y}}))      // one spectrum per region of the file
        : [{name: base, d: parseTxt(await f.text())}];
      for (const it of list) { const id = nid();
        DATA[id] = it.d; const sp = newSpec(it.name, id); sp.file = f.name;
        { const q = S.spectra.find(z => sameRegion(z, sp)); if (q) { sp.despike = {...q.despike}; sp.bg = {...q.bg}; sp.zero = {...q.zero}; } }      // new spectra take the settings of their own region
        sp.fit.auto = true; autoRange(sp);
        S.spectra.push(sp); last = id; n++; }
    } catch (e) { bad.push(f.name + ': ' + e.message); }
  }
  if (last) { S.sel = last; }
  if (n) commit(`Load ${n} spectr${n > 1 ? 'a' : 'um'}`);
  msg(bad.length ? 'Not loaded: ' + bad.join('; ') : n ? `${n} ${n > 1 ? 'spectra' : 'spectrum'} loaded` : '');
  if (n && window.NQP && NQP.log) NQP.log('xps_load', {n});
}

// ---------------- processing: despike + background ----------------
const median = a => { const b = Float64Array.from(a).sort(), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
function despike(y, thr) {                     // 2nd difference > thr × MAD; the point and 2 on each side are bad; linear interpolation
  const n = y.length, d = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) d[i] = y[i] - (y[i - 1] + y[i + 1]) / 2;
  const dd = d.slice(1, n - 1), M = median(dd), mad = median(dd.map(v => Math.abs(v - M))) || 1e-12;
  const bad = new Uint8Array(n); let cnt = 0;
  for (let i = 1; i < n - 1; i++) if (Math.abs(d[i]) > thr * mad) { cnt++; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) bad[j] = 1; }
  const out = Float64Array.from(y);
  for (let i = 0; i < n; i++) if (bad[i]) {
    let a = i - 1; while (a >= 0 && bad[a]) a--; let b = i + 1; while (b < n && bad[b]) b++;
    out[i] = a < 0 ? (b < n ? y[b] : y[i]) : b >= n ? y[a] : y[a] + (y[b] - y[a]) * (i - a) / (b - a);
  }
  return {y: out, n: cnt};
}
function solve(A, b) {                         // Gaussian elimination, partial pivoting (small systems)
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]]; const v = M[c][c]; if (Math.abs(v) < 1e-300) return null;
    for (let r = c + 1; r < n; r++) { const f = M[r][c] / v; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
  return x;
}
// Background between the two ends of a window [i0, i1] (indices; x ascending). The end levels are means of navg points.
//   linear  — straight line between the two end levels
//   shirley — iterative Shirley: at each energy the background rises in proportion to the peak area on the low-binding-energy side
// Outside the window the background equals the data, so the corrected spectrum is 0 there.
// cuts = indices inside the window where the background is split: every part between two neighbouring nodes gets its own
// background (as separate regions in CasaXPS), and the parts join at the nodes. The level at a node is the mean of navg points
// (inward from the two ends of the window, centred on a cut).
function background(y, kind, i0, i1, navg, cuts) {
  const base = Array.from(y); if (i1 - i0 < 3) return base;
  const nodes = [i0, ...(cuts || []).filter(c => c > i0 + 2 && c < i1 - 2).sort((a, b) => a - b), i1].filter((c, k, A) => !k || c - A[k - 1] > 2);
  if (nodes[nodes.length - 1] !== i1) nodes[nodes.length - 1] = i1;
  const k = Math.max(1, Math.min(navg | 0 || 1, Math.floor((i1 - i0) / 4) || 1)), mean = (a, b) => { let t = 0; for (let i = a; i <= b; i++) t += y[i]; return t / (b - a + 1); };
  const level = nodes.map((c, j) => j === 0 ? mean(i0, i0 + k - 1) : j === nodes.length - 1 ? mean(i1 - k + 1, i1) : mean(Math.max(i0, c - (k >> 1)), Math.min(i1, c + (k >> 1))));
  for (let s = 0; s + 1 < nodes.length; s++) {
    const a = nodes[s], b = nodes[s + 1], ya = level[s], yb = level[s + 1], m = b - a + 1, B = new Float64Array(m);
    for (let j = 0; j < m; j++) B[j] = ya + (yb - ya) * j / (m - 1);
    if (kind === 'shirley') {
      const cum = new Float64Array(m);
      for (let it = 0; it < 60; it++) {
        cum[0] = 0; for (let j = 1; j < m; j++) cum[j] = cum[j - 1] + ((y[a + j] - B[j]) + (y[a + j - 1] - B[j - 1])) / 2;   // equal steps assumed (ratio only)
        const tot = cum[m - 1]; if (!(Math.abs(tot) > 1e-300)) break;
        let dmax = 0; for (let j = 0; j < m; j++) { const v = ya + (yb - ya) * cum[j] / tot; dmax = Math.max(dmax, Math.abs(v - B[j])); B[j] = v; }
        if (dmax < 1e-6 * (Math.abs(yb - ya) + 1e-300)) break;
      }
    }
    for (let j = 0; j < m; j++) base[a + j] = B[j];
  }
  return base;
}
// background is two steps: method 'on' + applied:false = background only shown (dashed) on the original spectrum, type and window can be chosen;
// applied:true = baseline subtracted (projects saved before this have no flag and count as subtracted)
const bgShown = sp => sp.bg.method === 'on', bgDone = sp => false;      // XPS: the background is used for the fit but never taken out of the plots
const ZERO_W = 30;                              // width of the noise segment used for the zero level (not used in the XPS tab)
const zeroOn = sp => !!sp.zero && (sp.zero.on || sp.zero.mode === undefined);   // projects saved before the Zero row always applied their window
const PCACHE = new Map();
function proc(sp) {
  const key = sp.id + JSON.stringify([sp.despike, sp.bg, sp.zero, sp.shift, sp.shiftOn]);
  if (PCACHE.has(key)) return PCACHE.get(key);
  const d = DATA[sp.id]; if (!d) return null;
  const ds = {y: Float64Array.from(d.y), n: 0};                                  // XPS: no despike
  const b = sp.bg, ys = Array.from(ds.y);
  const sh0 = sp.shiftOn ? +sp.shift || 0 : 0;                                  // the typed window is in corrected (shifted) energies
  let i0 = 0, i1 = ys.length - 1;
  if (b.a != null && b.b != null && b.a !== '' && b.b !== '' && isFinite(+b.a) && isFinite(+b.b) && +b.a !== +b.b) { const lo = Math.min(+b.a, +b.b) - sh0, hi = Math.max(+b.a, +b.b) - sh0;
    while (i0 < i1 && d.x[i0] < lo) i0++; while (i1 > i0 && d.x[i1] > hi) i1--; }
  const cuts = (b.cuts || []).map(e => nearestIdx(d.x, +e - sh0));                  // split energies are charge-corrected ones too
  const base = b.method === 'on' ? background(ys, b.kind || 'shirley', i0, i1, +b.navg || 1, cuts) : ys.map(() => 0);
  // The background stays in the plots: the spectra are shown as measured, with the background as a dashed line and the peaks standing on it.
  // The peaks are fitted to y = data − background.
  const done = false;
  let y = ys.map((v, i) => v - base[i]);
  const sh = sp.shiftOn ? +sp.shift || 0 : 0, x = d.x.map(v => v + sh);
  // zero level (after the background is removed): mean of a noise segment is set to 0.
  //   auto   — the first and the last ZERO_W units of the spectrum are both tried; the one with the lower mean is used
  //   manual — the typed window
  let zero = null;
  if (done && zeroOn(sp)) {
    const seg = (a, b) => { let sm = 0, n = 0; for (let i = 0; i < x.length; i++) if (x[i] >= a && x[i] <= b) { sm += y[i]; n++; } return n ? {a, b, v: sm / n} : null; };
    if (sp.zero.mode === 'auto') { const lo = Math.min(x[0], x[x.length - 1]), hi = Math.max(x[0], x[x.length - 1]);
      const A = seg(lo, lo + ZERO_W), B = seg(hi - ZERO_W, hi); zero = A && B ? (A.v <= B.v ? A : B) : A || B; if (zero) zero.edge = zero === A ? 'low' : 'high'; }
    else zero = seg(Math.min(+sp.zero.a, +sp.zero.b), Math.max(+sp.zero.a, +sp.zero.b));
    if (zero && isFinite(zero.v)) { const z = zero.v; y = y.map(v => v - z); for (let i = 0; i < base.length; i++) base[i] += z; } else zero = null;
  }
  const r = {x, raw: d.y, ds: ys, base, y, spikes: ds.n, zero};
  if (PCACHE.size > 200) PCACHE.delete(PCACHE.keys().next().value);
  PCACHE.set(key, r); return r;
}

// ---------------- peaks: pseudo-Voigt (eta = Lorentz fraction; 0 = pure Gaussian) ----------------
function pv(x, p) { const d = (x - p.c) / p.w, d2 = d * d; return p.h * ((1 - p.eta) * Math.exp(-4 * LN2 * d2) + p.eta / (1 + 4 * d2)); }
const area = p => p.h * p.w * ((1 - p.eta) * Math.sqrt(Math.PI / (4 * LN2)) + p.eta * Math.PI / 2);
function inRange(sp) {
  const r = proc(sp), [a, b] = sp.fit.range, x = [], y = [];
  for (let i = 0; i < r.x.length; i++) if (r.x[i] >= a && r.x[i] <= b) { x.push(r.x[i]); y.push(r.y[i]); }
  return {x, y};
}
// peak limits: p.lim = {c:[a,b], w:[a,b], eta:[a,b]} (from a rule); a == b means fixed.  p.lock fixes c and w.
const lim = (p, k) => (p.lim && p.lim[k]) || null;
// Doublet: p.link = {to: id of the main peak, d: splitting (eV, this peak sits at main + d), r: area ratio this / main}.
// A linked peak has no free parameters: position, width and shape follow the main peak, height = main height × r (same shape, so heights and areas scale alike).
function sync(peaks) {
  for (const p of peaks) if (p.link) { const m = peaks.find(q => q.id === p.link.to);
    if (!m || m.link) { delete p.link; continue; }
    p.c = m.c + (+p.link.d || 0); p.w = m.w; p.eta = m.eta; p.h = m.h * (+p.link.r || 0); }
}
const mainOf = (peaks, p) => (p.link && peaks.find(q => q.id === p.link.to)) || p;
function freeKeys(p) {
  if (p.link) return [];
  const K = [];
  for (const k of ['c', 'w']) { const L = lim(p, k); if (!p.lock && !(L && L[0] === L[1])) K.push(k); }
  K.push('h');
  const L = lim(p, 'eta'); if (p.etaFree && !(L && L[0] === L[1])) K.push('eta');
  return K;
}
function clampP(p, x0, x1) {
  const L = k => lim(p, k);
  p.w = Math.min(Math.max(p.w, 0.1), (x1 - x0) * 3); p.h = Math.max(0, p.h); p.eta = Math.min(1, Math.max(0, p.eta));
  p.c = Math.min(Math.max(p.c, x0 - 2), x1 + 2);
  for (const k of ['c', 'w', 'eta']) { const l = L(k); if (l) p[k] = Math.min(Math.max(p[k], l[0]), l[1]); }
}
function lm(x, y, peaks, {iters = 100, fix = null, wt = null} = {}) {      // Levenberg–Marquardt, optional weights wt[i]
  const P = [];
  for (const p of peaks) if (p.id !== fix) for (const k of freeKeys(p)) P.push([p, k]);
  const n = x.length, m = P.length; if (!m || n < m) return Infinity;
  const sw = wt ? wt.map(Math.sqrt) : null, x0 = x[0], x1 = x[n - 1];
  const model = () => { sync(peaks); const f = new Float64Array(n); for (const p of peaks) for (let i = 0; i < n; i++) f[i] += pv(x[i], p); return f; };
  const sse = f => { let s = 0; for (let i = 0; i < n; i++) { const r = (y[i] - f[i]) * (sw ? sw[i] : 1); s += r * r; } return s; };
  let f = model(), s0 = sse(f), lam = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = P.map(([p, k]) => { const v = p[k], d = k === 'eta' ? 1e-3 : Math.max(Math.abs(v) * 1e-5, 1e-5), c = new Float64Array(n);
      p[k] = v + d; const f2 = model(); p[k] = v; for (let i = 0; i < n; i++) c[i] = (f2[i] - f[i]) / d * (sw ? sw[i] : 1); return c; });   // whole model: linked peaks move with their main peak
    sync(peaks);
    const A = Array.from({length: m}, () => new Array(m).fill(0)), g = new Array(m).fill(0);
    for (let a = 0; a < m; a++) { for (let i = 0; i < n; i++) g[a] += J[a][i] * (y[i] - f[i]) * (sw ? sw[i] : 1);
      for (let b = a; b < m; b++) { let s = 0; for (let i = 0; i < n; i++) s += J[a][i] * J[b][i]; A[a][b] = A[b][a] = s; } }
    let ok = false;
    for (let t = 0; t < 10; t++) {
      const B = A.map((r, i) => r.map((v, j) => i === j ? v * (1 + lam) + 1e-12 : v)), dlt = solve(B, g); if (!dlt) { lam *= 10; continue; }
      const old = peaks.map(p => ({...p}));
      P.forEach(([p, k], i) => { p[k] += dlt[i]; }); for (const p of peaks) if (p.id !== fix && !p.link) clampP(p, x0, x1);
      const f2 = model(), s2 = sse(f2);
      if (s2 < s0) { const rel = (s0 - s2) / (s0 || 1); f = f2; s0 = s2; lam = Math.max(lam / 3, 1e-9); ok = true; if (rel < 1e-10) it = iters; break; }
      peaks.forEach((p, i) => Object.assign(p, old[i])); lam *= 4;
    }
    if (!ok) break;
  }
  sync(peaks);
  return s0;
}
function fitStats(sp) {
  if (!sp.fit.range || !sp.fit.peaks.length) return null;
  const {x, y} = inRange(sp); if (!x.length) return null;
  sync(sp.fit.peaks);
  let mean = 0; for (const v of y) mean += v; mean /= y.length;
  let ss = 0, st = 0; for (let i = 0; i < x.length; i++) { let f = 0; for (const p of sp.fit.peaks) f += pv(x[i], p); ss += (y[i] - f) ** 2; st += (y[i] - mean) ** 2; }
  return {r2: 1 - ss / st, noise: Math.sqrt(ss / x.length)};       // noise: standard deviation of (corrected − fit) in the fit range
}
const snr = (p, st) => st && st.noise > 0 ? p.h / st.noise : NaN;   // signal-to-noise ratio of a peak: height / noise
const snrTxt = v => !isFinite(v) ? '' : v >= 100 ? v.toFixed(0) : v.toFixed(1);
function weights(sp, x) { const W = sp.fit.weight; return W ? x.map(v => v >= W.a && v <= W.b ? W.w : 1) : null; }
function runFit(sp, opt = {}) {
  if (!sp || !sp.fit.range || !sp.fit.peaks.length) return;
  const {x, y} = inRange(sp), wt = weights(sp, x), P = sp.fit.peaks;
  if (!opt.starts) return lm(x, y, P, {...opt, wt});
  // multi-start: current values + random starts inside the limits; keep the lowest (weighted) residual
  let best = P.map(p => ({...p})), bs = lm(x, y, P, {...opt, wt}); best = P.map(p => ({...p}));
  const ymax = Math.max(...y);
  for (let s = 1; s < opt.starts; s++) {
    const T = best.map(p => { const q = {...p}, L = k => lim(q, k), rnd = (a, b) => a + Math.random() * (b - a);
      if (freeKeys(q).includes('c')) { const l = L('c'); q.c = l ? rnd(l[0], l[1]) : q.c + rnd(-0.4, 0.4); }
      if (freeKeys(q).includes('w')) { const l = L('w'); q.w = l ? rnd(l[0], l[1]) : q.w * rnd(0.75, 1.3); }
      if (freeKeys(q).includes('eta')) { const l = L('eta') || [0, 1]; q.eta = rnd(l[0], l[1]); }
      q.h = rnd(0.2, 1) * ymax; return q; });
    const sc = lm(x, y, T, {...opt, wt}); if (sc < bs) { bs = sc; best = T; }
  }
  best.forEach((q, i) => Object.assign(P[i], q));
  return bs;
}

// ---------------- rule presets: none yet (to be added from real data) ----------------
// ---- NMC modules. A module sets the background, the fitting range and a fixed list of peaks with limits; everything can be changed afterwards in the table.
// m3p — the 45–80 eV region of an NMC cathode: Mn 3p, Li 1s, Co 3p (+ satellite), Ni 3p3/2 and 3p1/2 (+ their satellites).
//       Energies are for charge-corrected spectra (C 1s at 284.8 eV), so the charge correction is switched on first when it is not yet.
//       lim = [low, high] for centre (eV) and width (eV); Ni 3p1/2 is tied to Ni 3p3/2 (splitting, area ratio 1:2, same width).
//       Peak shape: 80 % Gaussian + 20 % Lorentzian (sum form), as the group uses; new peaks added by hand start with the same shape.
const RULES = {manual: 'Manual peaks', m3p: 'NMC 3p region: Mn 3p · Li 1s · Co 3p · Ni 3p'};
const M3P = {range: [45, 80], cuts: [52.0, 57.5, 64.0], top: [75, 80], peaks: [
  {key: 'Mn', name: 'Mn 3p',         c: 49.5, w: 2.6, lim: {c: [48.5, 50.6], w: [1.5, 4.0]}, color: '#d62728'},
  {key: 'Li', name: 'Li 1s',         c: 54.0, w: 2.2, lim: {c: [53.0, 55.3], w: [1.2, 3.5]}, color: '#e377c2'},
  {key: 'Co', name: 'Co 3p',         c: 60.8, w: 2.8, lim: {c: [59.6, 62.0], w: [1.5, 4.5]}, color: '#ff7f0e'},
  {key: 'Ni', name: 'Ni 3p3/2',      c: 67.1, w: 2.4, lim: {c: [66.2, 68.0], w: [1.5, 3.5]}, color: '#1f3fd0'},
  {key: 'Ni2', name: 'Ni 3p1/2',     link: {to: 'Ni', d: 1.9, r: 0.5}, color: '#6a1b9a'},
  {key: 'CoS', name: 'Co 3p sat.',   c: 70.4, w: 1.5, lim: {c: [69.7, 71.1], w: [0.8, 2.5]}, color: '#ff9896'},
  {key: 'NiS', name: 'Ni 3p3/2 sat.', c: 71.8, w: 2.2, lim: {c: [71.1, 72.8], w: [1.2, 3.5]}, color: '#7b8cff'},
  {key: 'NiS2', name: 'Ni 3p1/2 sat.', c: 73.9, w: 2.2, lim: {c: [73.0, 75.0], w: [1.2, 3.5]}, color: '#b07cc6'}]};
function applyRule(sp, rule) {
  sp.fit.rule = RULES[rule] ? rule : 'manual'; sp.fit.weight = null;
  if (sp.fit.rule !== 'm3p') return '';
  const d = DATA[sp.id]; if (!d) return '';
  if (!S.spectra.some(q => q.shiftOn && q.shift)) applyCharge(true);                      // preset energies are charge-corrected ones
  const sh = sp.shiftOn ? +sp.shift || 0 : 0, lo = d.x[0] + sh, hi = d.x[d.x.length - 1] + sh;
  if (hi < 56 || lo > 66) { sp.fit.rule = 'manual'; return 'This module is for the 45–80 eV region; the selected spectrum does not cover it.'; }
  // lowest point of the lightly smoothed data between two energies (corrected scale): where a region of the background ends
  const valley = (e0, e1) => { let k = -1, kv = Infinity; for (let i = 2; i < d.x.length - 2; i++) { const e = d.x[i] + sh; if (e < e0 || e > e1) continue;
    const v = (d.y[i - 2] + d.y[i - 1] + d.y[i] + d.y[i + 1] + d.y[i + 2]) / 5; if (v < kv) { kv = v; k = i; } } return k < 0 ? null : +(d.x[k] + sh).toFixed(2); };
  const a = Math.max(lo, M3P.range[0]), b = Math.min(hi, valley(M3P.top[0], M3P.top[1]) ?? M3P.range[1]);
  const cuts = M3P.cuts.map(c => valley(c - 1, c + 1) ?? c).filter(c => c > a + 1 && c < b - 1);      // one background for each group of peaks: Mn 3p | Li 1s | Co 3p | Ni 3p
  sp.fit.range = [a, b]; sp.fit.auto = false; sp.bg = {...sp.bg, method: 'on', kind: 'shirley', navg: 3, a: +a.toFixed(2), b: +b.toFixed(2), cuts, applied: false};
  PCACHE.clear(); const r = proc(sp), ids = {};
  for (const t of M3P.peaks) ids[t.key] = nid();
  sp.fit.peaks = M3P.peaks.filter(t => t.link || (t.c > a && t.c < b)).map(t => { const i = t.link ? 0 : nearestIdx(r.x, t.c);
    return t.link ? {id: ids[t.key], key: t.key, name: t.name, c: 0, w: 1, h: 0, eta: 0.2, etaFree: false, lock: false, color: t.color, link: {to: ids[t.link.to], d: t.link.d, r: t.link.r}}
      : {id: ids[t.key], key: t.key, name: t.name, c: t.c, w: t.w, h: Math.max(r.y[i] * 0.7, 1e-6), eta: 0.2, etaFree: false, lock: false, color: t.color, lim: {c: t.lim.c.slice(), w: t.lim.w.slice()}}; });
  sp.fit.ratios = []; ACTIVE = null;
  runFit(sp, {iters: 250, starts: 10});
  return '';
}

// ---------------- canvas plotting (same look as the cycling plots) ----------------
function ticks(a, b, n) {
  const span = b - a || 1; let st = Math.pow(10, Math.floor(Math.log10(span / n))); const e = span / n / st;
  st *= e >= 7.5 ? 10 : e >= 3.5 ? 5 : e >= 1.5 ? 2 : 1;
  const t = []; for (let v = Math.ceil(a / st) * st; v <= b + st * 1e-9; v += st) t.push(+v.toFixed(10)); return t;
}
const tfmt = v => Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-3) ? v.toExponential(1) : String(+v.toFixed(6));
let EXPORTING = false;                         // PNG export: same plot (range, size, labels), without on-screen helpers (selection highlight, range band) and with all tick numbers
function drawPlot(cv, H, o) {
  const W = cv.parentElement.clientWidth || 600, r = window.devicePixelRatio || 1;
  cv.width = W * r; cv.height = H * r; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
  const L = 92, R = 16, T = 16, B = 56, pw = W - L - R, ph = H - T - B;
  const [x0, x1] = o.xr, [y0, y1] = o.yr;
  const px = x => L + (x1 - x) / (x1 - x0) * pw, py = y => T + (1 - (y - y0) / (y1 - y0)) * ph;      // binding energy: high on the left
  g.font = '12px -apple-system, "Segoe UI", sans-serif'; g.fillStyle = '#1d2329'; g.strokeStyle = '#e6e8eb'; g.lineWidth = 1;
  g.textAlign = 'center'; g.textBaseline = 'top';
  const xt = ticks(x0, x1, Math.max(3, pw / 90));       // no grid lines; x: numbers + short tick marks, y: no numbers (arbitrary units)
  for (const t of xt) { const X = Math.round(px(t)) + .5; if (EXPORTING || (X > L + 52 && X < L + pw - 52)) g.fillText(tfmt(t), X, T + ph + 6); }
  const ytw = 0;
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(o.xlabel || '', L + pw / 2, H - 6);
  g.save(); g.translate(Math.max(13, L - 6 - Math.ceil(ytw) - 8 - 3), T + ph / 2); g.rotate(-Math.PI / 2); g.fillText(o.ylabel || '', 0, 0); g.restore();   // same spacing as the cycling plots
  g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
  for (const b of o.bands || []) { g.fillStyle = b.color; g.fillRect(px(b.a), T, px(b.b) - px(b.a), ph);
    if (b.edge) { g.strokeStyle = b.edge; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(px(b.a), T); g.lineTo(px(b.a), T + ph); g.moveTo(px(b.b), T); g.lineTo(px(b.b), T + ph); g.stroke(); g.setLineDash([]); } }
  for (const v of o.vlines || []) { g.strokeStyle = v.color; g.setLineDash([5, 4]); g.lineWidth = 1.3; g.beginPath(); g.moveTo(px(v.x), T); g.lineTo(px(v.x), T + ph); g.stroke(); g.setLineDash([]); g.lineWidth = 1; }
  const labels = [];
  for (const s of o.series) {
    const n = s.x.length; if (!n) continue;
    if (s.fill) { const B = Array.isArray(s.base) ? s.base : null; g.fillStyle = s.fill; g.beginPath(); g.moveTo(px(s.x[0]), py(B ? B[0] : s.base || 0));
      for (let i = 0; i < n; i++) g.lineTo(px(s.x[i]), py(s.y[i]));
      if (B) for (let i = n - 1; i >= 0; i--) g.lineTo(px(s.x[i]), py(B[i])); else g.lineTo(px(s.x[n - 1]), py(s.base || 0));
      g.closePath(); g.fill(); }
    if (s.points) { g.strokeStyle = s.color; g.lineWidth = 1; const rr = s.points;
      for (let i = 0; i < n; i++) { g.beginPath(); g.arc(px(s.x[i]), py(s.y[i]), rr, 0, 7); g.stroke(); } }
    if (s.width !== 0 && !s.points) { g.strokeStyle = s.color; g.lineWidth = s.width || 1.5; g.setLineDash(s.dash || []);
      g.beginPath(); for (let i = 0; i < n; i++) { const X = px(s.x[i]), Y = py(s.y[i]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); } g.stroke(); g.setLineDash([]); }
    if (s.label) { g.fillStyle = s.color; g.font = (s.bold ? '600 ' : '') + '11.5px -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'center';
      const tw = g.measureText(s.label).width, lo = L + 4 + tw / 2, hi = L + pw - 6 - tw / 2;      // label centre: at labelX if given, else at the right edge; kept inside the plot
      const cx = hi < lo ? L + pw / 2 : Math.min(hi, Math.max(lo, s.labelX != null ? px(s.labelX) : hi)), by = py(s.labelY) + (s.labelDy != null ? s.labelDy : -4);
      g.fillText(s.label, cx, by); labels.push({id: s.id, cx, by, x0: cx - tw / 2 - 3, x1: cx + tw / 2 + 3, y0: by - 12, y1: by + 4});
      g.font = '12px -apple-system, "Segoe UI", sans-serif'; }
  }
  for (const m of o.marks || []) {
    const X = px(m.x), Y = py(m.y); g.fillStyle = m.color; g.font = '600 11px -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'center';
    g.fillText(m.text, X, Y - 10); g.beginPath(); g.arc(X, Y, m.on ? 6 : 4.5, 0, 7); g.fillStyle = m.on ? '#fff' : m.color; g.fill();
    g.lineWidth = 2; g.strokeStyle = m.color; g.stroke(); g.lineWidth = 1;
  }
  for (const z of o.drag ? [o.drag] : []) { g.fillStyle = z.color; g.fillRect(Math.min(px(z.a), px(z.b)), T, Math.abs(px(z.b) - px(z.a)), ph); }
  g.restore();
  g.strokeStyle = '#c9ced5'; g.strokeRect(L + .5, T + .5, pw, ph);
  g.beginPath(); for (const t of xt) { const X = Math.round(px(t)) + .5; if (X > L + 1 && X < L + pw - 1) { g.moveTo(X, T + ph); g.lineTo(X, T + ph - 5); } } g.stroke();
  return {px, py, ix: X => x1 - (X - L) / pw * (x1 - x0), iy: Y => y0 + (1 - (Y - T) / ph) * (y1 - y0), L, T, pw, ph, labels};
}
const extent = (arrs, pad = 0.04) => { let a = Infinity, b = -Infinity; for (const r of arrs) for (const v of r) { if (v < a) a = v; if (v > b) b = v; }
  if (!isFinite(a)) return [0, 1]; const d = (b - a) || 1; return [a - d * pad, b + d * pad]; };

// ---------------- axis limits (typed, as in the cycling tab) ----------------
// One x range for both plots: the waterfall sets it and the fitting plot follows. y is separate for each plot.
const LIMS = {x: [null, null], wf: [null, null], fit: [null, null]};
const fill = (lim, auto) => { let a = lim[0] ?? auto[0], b = lim[1] ?? auto[1]; if (!(b > a)) { a = auto[0]; b = auto[1]; } return [a, b]; };
function xAuto() {
  const xs = S.spectra.filter(s => s.show && DATA[s.id] && inRegion(s)).map(s => proc(s).x), sp = cur();
  if (!xs.length && sp && DATA[sp.id]) xs.push(proc(sp).x);
  return xs.length ? extent(xs, 0) : [280, 295];
}
const xRange = () => fill(LIMS.x, xAuto());
const redrawBoth = () => { drawWf(); drawFit(); };
function fmtL(v, span) { const d = span >= 200 ? 0 : span >= 5 ? 1 : span >= 0.5 ? 2 : 3; return String(+v.toFixed(d)); }
function axisUI(cv, F, ykey, xr, yr) {
  const host = cv.parentElement; host.style.position = 'relative';
  let ui = host._ax;
  if (!ui) {
    ui = host._ax = {};
    const box = (k, lim, i, cls) => { const e = document.createElement('input'); e.type = 'text'; e.className = 'lim ' + cls; e.title = 'Type a value; empty = auto';
      e.addEventListener('focus', () => e.select());
      e.addEventListener('keydown', ev => { ev.stopPropagation(); if (ev.key === 'Enter') e.blur(); if (ev.key === 'Escape') { e.value = e.dataset.v; e.blur(); } });
      e.addEventListener('change', () => { const t = e.value.trim(); LIMS[lim][i] = t === '' || isNaN(+t) ? null : +t; redrawBoth(); });
      host.appendChild(e); ui[k] = e; };
    box('x0', 'x', 1, ''); box('x1', 'x', 0, 'r'); box('y1', ykey, 1, 'r'); box('y0', ykey, 0, 'r');      // left box = high end of the binding-energy axis
    const btn = (k, lim) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'axauto'; b.textContent = 'auto';
      b.title = 'Autoscale ' + k.toUpperCase(); b.onclick = () => { LIMS[lim] = [null, null]; redrawBoth(); }; host.appendChild(b); ui[k] = b; };
    btn('ax', 'x'); btn('ay', ykey);
  }
  const put = (e, l, t) => { e.style.left = l + 'px'; e.style.top = t + 'px'; };
  put(ui.x0, F.L - 4, F.T + F.ph + 4); put(ui.x1, F.L + F.pw - 46, F.T + F.ph + 4);
  put(ui.y1, F.L - 56, F.T - 9); put(ui.y0, F.L - 56, F.T + F.ph - 10);
  put(ui.ay, F.L - 90, F.T - 7); put(ui.ax, F.L + F.pw - 34, F.T + F.ph + 27);
  const val = (e, v, span, set) => { if (document.activeElement !== e) e.value = e.dataset.v = fmtL(v, span); e.classList.toggle('set', set); };
  val(ui.x0, xr[1], xr[1] - xr[0], LIMS.x[1] != null); val(ui.x1, xr[0], xr[1] - xr[0], LIMS.x[0] != null);
  val(ui.y0, yr[0], yr[1] - yr[0], LIMS[ykey][0] != null); val(ui.y1, yr[1], yr[1] - yr[0], LIMS[ykey][1] != null);
  ui.ax.classList.toggle('set', LIMS.x.some(v => v != null)); ui.ay.classList.toggle('set', LIMS[ykey].some(v => v != null));
}

// ---------------- page layout ----------------
function build() {
  const tb = $('.toolbar[data-pane=xps]');
  tb.innerHTML = `
    <label class="rdrop" id="xr_drop" title="Drop XPS spectra here: PHI MultiPak .spe files (every region becomes a spectrum) or text files with two columns (binding energy, intensity); or click to choose several">
      <input type="file" id="xr_file" multiple accept=".spe,.txt,.csv,.dat,.xy,.asc,.json" hidden>
      <span class="ic">⇣</span><span><b>Drop XPS spectra here</b><br><u>or click to choose files…</u></span></label>
    <span class="hbtns">
      <button type="button" id="xr_undo" class="big" title="Undo (Ctrl+Z)">↶ Undo</button>
      <button type="button" id="xr_redo" class="big" title="Redo (Ctrl+Y)">↷ Redo</button>
      <button type="button" id="xr_hist" title="All steps">Steps <b id="xr_hn">0</b> ▾</button>
    </span>
    <span class="sp"></span>
    <span id="xr_save" class="gmuted"></span>
    <button type="button" id="xr_export" class="primary" title="Write corrected spectra, fit curves and peak tables">Export results</button>`;
  const sec = $('section[data-pane=xps]');
  sec.innerHTML = `
    <div id="xr_msg"></div>
    <div class="rgrid" id="xr_grid">
      <div class="mod rwf">
        <div class="rsplit" id="xr_split" title="Drag to make the plots narrower or wider · double-click: half and half"></div>
        <div class="bar"><span class="t">Spectra</span>
          <span class="opts">
          <label><input type="checkbox" id="xwf_norm"> normalize</label> <label>offset <input type="number" id="xwf_off" step="0.1" style="width:56px"></label>
          <label title="Draw the fitted peaks and their sum on every curve"><input type="checkbox" id="xwf_fits"> fits</label></span>
          <button type="button" class="primary" id="xft_open">Open fitting ▸</button>
          <button type="button" class="expbtn" data-xpng="wf">Export PNG</button></div>
        <div class="hintrow" id="xwf_hint"></div>
        <div class="plot"><canvas id="xwf_cv"></canvas></div>
        <div id="xwf_list"></div>
        <div class="pre" id="xwf_pre"></div>
      </div>
      <div class="mod rfit" id="xr_fit" hidden>
        <div class="bar"><span class="t" id="xft_title">Fitting</span>
          <span id="xft_btns" class="opts"></span>
          <button type="button" id="xft_close" title="Close the fitting panel">✕ Close</button>
          <button type="button" class="expbtn" data-xpng="fit">Export PNG</button></div>
        <div class="hintrow" id="xft_hint"></div>
        <div class="plot"><canvas id="xft_cv"></canvas></div>
        <div class="side" id="xft_side"></div>
      </div>
    </div>`;
  $('#xft_open').onclick = () => { FITOPEN = true; render(); };
  $('#xft_close').onclick = () => { FITOPEN = false; render(); };
  // file input / drop
  $('#xr_file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#xr_drop');
  for (const el of [dz, sec]) {
    el.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    el.addEventListener('dragleave', () => dz.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  }
  $('#xr_undo').onclick = undo; $('#xr_redo').onclick = redo;
  $('#xr_hist').onclick = showHist;
  { // divider on the right edge of the spectra card: drag = share of the width (kept in this browser)
    const grid = $('#xr_grid'), h = $('#xr_split');
    const setF = f => { if (f == null) { grid.style.removeProperty('--rl'); grid.style.removeProperty('--rr'); } else { grid.style.setProperty('--rl', f + 'fr'); grid.style.setProperty('--rr', (1 - f) + 'fr'); } drawWf(); drawFit(); };
    try { const f = +localStorage.getItem('nqp_xsplit'); if (f >= 0.2 && f <= 0.85) setF(f); } catch {}
    let drag = false, raf = 0;
    h.addEventListener('pointerdown', e => { drag = true; h.classList.add('on'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
    h.addEventListener('pointermove', e => { if (!drag) return; const r = grid.getBoundingClientRect(), f = Math.min(0.85, Math.max(0.2, (e.clientX - r.left - 16 - 6) / (r.width - 32 - 12)));
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setF(+f.toFixed(3))); h._f = f; });
    const end = () => { if (!drag) return; drag = false; h.classList.remove('on'); try { if (h._f) localStorage.setItem('nqp_xsplit', h._f.toFixed(3)); } catch {} };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => { setF(null); h._f = 0; try { localStorage.removeItem('nqp_xsplit'); } catch {} });
  }
  for (const [id, key, redraw] of [['#xwf_cv', 'wf', () => drawWf()], ['#xft_cv', 'ft', () => drawFit()]]) {
    const host = $(id).parentElement, g = document.createElement('div'); g.className = 'pgrip'; g.title = 'Drag to make this plot narrower or wider · double-click: full width';
    host.style.position = 'relative'; host.appendChild(g);
    const saved = () => { try { return JSON.parse(localStorage.getItem('nqp_xplotw')) || {}; } catch { return {}; } };
    const keep = w => { try { const o = saved(); if (w) o[key] = w; else delete o[key]; localStorage.setItem('nqp_xplotw', JSON.stringify(o)); } catch {} };
    const setW = w => { if (w) host.style.width = w + 'px'; else host.style.removeProperty('width'); redraw(); };
    { const w = +saved()[key]; if (w >= 240) host.style.width = w + 'px'; }
    let drag = false, raf = 0, last = 0;
    g.addEventListener('pointerdown', e => { drag = true; g.classList.add('on'); g.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); });
    g.addEventListener('pointermove', e => { if (!drag) return; const full = host.parentElement.clientWidth - 24;
      last = Math.round(Math.min(full, Math.max(240, e.clientX - host.getBoundingClientRect().left + 8)));
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setW(last)); });
    const end = () => { if (!drag) return; drag = false; g.classList.remove('on'); if (last) keep(last); };
    g.addEventListener('pointerup', end); g.addEventListener('pointercancel', end);
    g.addEventListener('dblclick', e => { e.stopPropagation(); last = 0; keep(0); setW(0); });
  }
  $('#xr_export').onclick = exportAll;
  $('#xwf_norm').onchange = e => { S.wf.norm = e.target.checked; commit(e.target.checked ? 'Waterfall: normalize' : 'Waterfall: no normalize'); };
  $('#xwf_off').onchange = e => { S.wf.offset = +e.target.value || 0; commit('Waterfall offset ' + S.wf.offset); };
  $('#xwf_fits').onchange = e => { S.wf.fits = e.target.checked; commit(e.target.checked ? 'Spectra: show fits' : 'Spectra: hide fits'); };
  document.querySelectorAll('[data-xpng]').forEach(b => b.onclick = () => savePng(b.dataset.xpng));
  document.addEventListener('keydown', e => {
    if ($('section[data-pane=xps]').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'escape' && PICK) { PICK = false; render(); }
    else if ((k === 'delete' || k === 'backspace') && ACTIVE && mode() === 'fit') { delPeak(ACTIVE); }
  });
  wfEvents(); fitEvents();
  new ResizeObserver(() => { if (!sec.hidden) { drawWf(); drawFit(); } }).observe(sec);
}
const msg = t => { const m = $('#xr_msg'); if (m) m.textContent = t; };

// ---------------- render ----------------
function render() {
  if (!$('#xwf_cv')) return;
  { const c = cur(), prev = S.spectra.find(s => s.id === LASTSEL);                // another region selected: typed axis limits of the old one do not apply
    if (c && c.id !== LASTSEL && !(prev && sameRegion(prev, c))) { LIMS.x = [null, null]; LIMS.wf = [null, null]; LIMS.fit = [null, null]; }
    LASTSEL = c ? c.id : null; }
  $('#xr_undo').disabled = HPOS <= 0; $('#xr_redo').disabled = HPOS >= HIST.length - 1;
  $('#xr_undo').title = HPOS > 0 ? 'Undo: ' + HIST[HPOS].label + ' (Ctrl+Z)' : 'Nothing to undo';
  $('#xr_redo').title = HPOS < HIST.length - 1 ? 'Redo: ' + HIST[HPOS + 1].label + ' (Ctrl+Y)' : 'Nothing to redo';
  $('#xr_hn').textContent = Math.max(0, HPOS);
  $('#xr_fit').hidden = !FITOPEN; $('#xft_open').hidden = FITOPEN;
  $('#xwf_hint').innerHTML = 'Click a curve to select it · double-click to reset the axes';
  $('#xwf_hint').classList.toggle('hint', PICK);
  $('#xwf_norm').checked = S.wf.norm; $('#xwf_off').value = S.wf.offset; $('#xwf_fits').checked = S.wf.fits !== false;
  renderList(); renderPre(); drawWf(); renderFitBar(); drawFit(); renderSide();
}
function renderList() {
  const box = $('#xwf_list');
  if (!S.spectra.length) { box.innerHTML = '<div class="empty">No spectra yet — drop PHI .spe files, or text files with two columns (binding energy in eV, intensity), on the box above.</div>'; return; }
  box.innerHTML = S.spectra.map(s => `<div class="srow${s.id === S.sel ? ' on' : ''}${inRegion(s) ? '' : ' other'}" data-id="${s.id}"${inRegion(s) ? '' : ' title="Another energy region: click to show the spectra of that region"'}>
    <input type="checkbox" ${s.show ? 'checked' : ''} title="Show in waterfall"><input type="color" value="${s.color}">
    <span class="nm" title="file: ${esc(s.file || s.name)}">${esc(s.name)}</span>
    <span class="meta">${s.fit.peaks.length ? s.fit.peaks.length + ' peaks' : ''}${bgShown(s) ? ' · ' + (s.bg.kind || 'shirley') + ' bg' : ''}</span>
    <span class="x" title="Remove">✕</span></div>`).join('');
  box.querySelectorAll('.srow').forEach(r => { const s = S.spectra.find(q => q.id === r.dataset.id);
    r.onclick = e => { if (e.target.tagName === 'INPUT' || e.target.classList.contains('x')) return; select(s.id); };
    r.querySelector('[type=checkbox]').onchange = e => { s.show = e.target.checked; commit((s.show ? 'Show ' : 'Hide ') + s.name); };
    r.querySelector('[type=color]').onchange = e => { s.color = e.target.value; commit('Colour ' + s.name); };
    r.querySelector('.x').onclick = () => { S.spectra = S.spectra.filter(q => q !== s); if (S.sel === s.id) S.sel = S.spectra[0] ? S.spectra[0].id : null; commit('Remove ' + s.name); };
  });
}
function select(id) { if (S.sel === id) return; S.sel = id; ACTIVE = null; commit('Select ' + (cur() || {}).name); }
// Charge correction, fixed rule: the strongest C 1s peak of a file goes to C_REF, and every region of the same file gets the same shift.
const C_REF = 284.8;
const isC1s = sp => { const d = DATA[sp.id]; if (!d) return false; const a = d.x[0], b = d.x[d.x.length - 1];
  return /^C\s*1s/i.test(sp.name) || (a <= 283 && b >= 287 && b - a <= 60); };          // by name, or a narrow scan around 285 eV
function c1sPeak(sp) {                          // energy of the highest point (as measured), refined with a parabola through its neighbours
  const d = DATA[sp.id]; let k = -1; for (let i = 0; i < d.x.length; i++) if (d.x[i] >= 278 && d.x[i] <= 295 && (k < 0 || d.y[i] > d.y[k])) k = i;
  if (k < 0) return null; if (k === 0 || k === d.x.length - 1) return d.x[k];
  const y0 = d.y[k - 1], y1 = d.y[k], y2 = d.y[k + 1], den = y0 - 2 * y1 + y2;
  return d.x[k] + (den < 0 ? 0.5 * (y0 - y2) / den : 0) * (d.x[k + 1] - d.x[k]);
}
function applyCharge(on) {
  const files = new Map(); for (const q of S.spectra) { const f = q.file || q.id; if (!files.has(f)) files.set(f, []); files.get(f).push(q); }
  let done = 0, none = 0; const notes = [];
  for (const [f, list] of files) {
    const c = on ? list.find(isC1s) : null, pk = c ? c1sPeak(c) : null, sh = pk == null ? 0 : +(C_REF - pk).toFixed(2);
    if (on && pk == null) none++; else if (on) { done++; notes.push(`${sh > 0 ? '+' : '−'}${Math.abs(sh).toFixed(2)}`); }
    for (const q of list) { q.shift = sh; q.shiftOn = sh !== 0; autoRange(q); }
  }
  PCACHE.clear(); for (const q of S.spectra) if (q.fit.peaks.length) runFit(q, {iters: 60});
  return {done, none, notes};
}
function chargeCorrect(on) {
  const {done, none, notes} = applyCharge(on);
  commit(on ? `Charge correction: C 1s to ${C_REF} eV (${notes.join(', ') || 'no C 1s found'} eV)` : 'Charge correction off');
  msg(on ? (done ? `Charge correction: ${done} file${done > 1 ? 's' : ''} shifted (${notes.join(', ')} eV)` : 'No C 1s spectrum found') + (none ? ` · ${none} file${none > 1 ? 's' : ''} without a C 1s spectrum, not shifted` : '') : 'Charge correction taken off');
}
function renderPre() {                          // the background acts on the spectra of the region; the shift is set curve by curve
  const sp = cur(), box = $('#xwf_pre');
  if (!sp) { box.innerHTML = ''; return; }
  const b = sp.bg, bgOn = bgShown(sp), chOn = S.spectra.some(q => q.shiftOn && q.shift);
  box.innerHTML = `
    <div class="prow"><button type="button" id="xbg_on" class="tg${bgOn ? ' on' : ''}" title="Background under the peaks, drawn as a dashed line. It stays in the plots; the peaks are fitted to the data minus this background.">Background</button>
      ${bgOn ? `<select id="xbg_pre"><option value="shirley">Shirley</option><option value="linear">linear</option></select>
      <label title="Each end level is the mean of this many points">ends: mean of <input type="number" id="xbg_l" value="${+b.navg || 1}" min="1" max="50" step="1" style="width:50px"> pts</label>
      <label title="Leave both empty to use the whole spectrum">from <input type="number" id="xbg_a" value="${b.a ?? ''}" step="0.1" style="width:66px"> to <input type="number" id="xbg_b" value="${b.b ?? ''}" step="0.1" style="width:66px"> eV</label>
      <label title="Energies where the background is split: every part gets its own background, as separate regions in CasaXPS. Separate with commas; empty = one background for the whole window.">split at <input type="text" id="xbg_c" value="${(b.cuts || []).join(', ')}" placeholder="e.g. 52, 57.5, 64" style="width:150px"> eV</label>` : '<span class="gmuted">dashed line under the peaks; it stays in the plot</span>'}</div>
    <div class="prow"><button type="button" id="xsh_pick" class="tg${chOn ? ' on' : ''}" title="Charge correction: in every file the strongest C 1s peak is moved to ${C_REF} eV, and all regions of that file are shifted by the same amount. Click again to take the shift off.">Charge corr.</button>
      <span>C 1s → ${C_REF} eV</span>
      <span class="gmuted">${sp.shiftOn && sp.shift ? `this spectrum: ${sp.shift > 0 ? '+' : '−'}${Math.abs(+sp.shift).toFixed(2)} eV` : chOn ? 'this spectrum: no C 1s in its file, not shifted' : 'not applied'}</span></div>`;
  if (bgOn) $('#xbg_pre').value = b.kind || 'shirley';
  const all = (fn, lab) => e => { const R = regionSpectra(); for (const q of R) fn(q, e.target); PCACHE.clear(); for (const q of R) if (q.fit.peaks.length) runFit(q, {iters: 60}); commit(lab(e.target)); };   // despike and background act on the spectra of this region
  const live = fn => e => { for (const q of regionSpectra()) fn(q, e.target); PCACHE.clear(); drawWf(); drawFit(); renderSide(); };
  $('#xbg_on').onclick = all(q => { q.bg.method = bgOn ? 'none' : 'on'; q.bg.applied = false; }, () => 'Background ' + (bgOn ? 'off' : 'on'));
  if (bgOn) {
    $('#xbg_pre').onchange = all((q, t) => { q.bg.kind = t.value; }, t => `Background ${t.value}`);
    $('#xbg_l').onchange = all((q, t) => q.bg.navg = Math.max(1, Math.round(+t.value) || 1), t => `Background ends: mean of ${t.value} points`);
    $('#xbg_c').onchange = all((q, t) => q.bg.cuts = t.value.split(/[,;\s]+/).map(Number).filter(v => isFinite(v) && v > 0).sort((x, y) => x - y), t => `Background split at ${t.value || 'nothing'}`);
    for (const k of ['a', 'b']) $('#xbg_' + k).onchange = all((q, t) => q.bg[k] = t.value === '' ? null : +t.value, () => `Background window ${$('#xbg_a').value || '…'}–${$('#xbg_b').value || '…'} eV`);
  }
  $('#xsh_pick').onclick = () => chargeCorrect(!chOn);
}

// ---------------- waterfall ----------------
let WF = null, wfDrag = null;
function wfCurves() {
  const shown = S.spectra.filter(s => s.show && DATA[s.id] && inRegion(s)), N = shown.length, out = [];
  shown.forEach((s, k) => {
    const r = proc(s), raw = true, y = r.ds;
    let sc = 1; if (S.wf.norm) { let mx = 0, mn = Infinity; for (const v of y) { if (v > mx) mx = v; if (v < mn) mn = v; } sc = 1 / ((mx - (raw ? mn : 0)) || 1); }
    const sub = raw && S.wf.norm ? Math.min(...y) : 0, off = (N - 1 - k) * S.wf.offset * (S.wf.norm ? 1 : 1);
    out.push({s, x: r.x, y: y.map(v => (v - sub) * sc + off), base: raw && s.bg.method !== 'none' ? r.base.map(v => (v - sub) * sc + off) : null, off, sc, sub, raw, r});
  });
  return out;
}
function drawWf() {
  const cv = $('#xwf_cv'); if (!cv || $('section[data-pane=xps]').hidden) return;
  const C = wfCurves(), all = C.map(c => c.x);
  const xr = xRange();
  const vis = C.map(c => c.y.filter((v, i) => c.x[i] >= xr[0] && c.x[i] <= xr[1]));
  const series = [];
  for (const c of C) { const on = c.s.id === S.sel && !EXPORTING;
    const lab = S.wf.lab, lx = lab ? xr[1] - lab.fx * (xr[1] - xr[0]) : null;       // every label sits at the same place relative to its own curve
    series.push({x: c.x, y: c.y, color: c.s.color, points: on ? 2.4 : 1.7, label: c.s.name, id: c.s.id, bold: on,      // measured points, as in the fitting plot
      labelX: lx, labelY: lab ? c.y[nearestIdx(c.x, lx)] : c.y[0], labelDy: lab ? lab.dy : null});
    if (c.base) series.push({x: c.x, y: c.base, color: c.s.color, width: 1, dash: [5, 4]});
    // the fit of this spectrum, drawn on its curve: each peak filled, their sum as a thin dark line
    const F = c.s.fit;
    if (S.wf.fits !== false && F.range && F.peaks.length) {
      sync(F.peaks);
      const xs = [], bs = []; for (let i = 0; i < c.x.length; i++) if (c.x[i] >= F.range[0] && c.x[i] <= F.range[1]) { xs.push(c.x[i]); bs.push(c.r.base[i]); }
      const tr = v => (v - c.sub) * c.sc + c.off, bt = bs.map(tr);                          // the peaks stand on the background
      if (xs.length > 1) {
        F.peaks.forEach((p, k) => { const col = p.color || PEAK_COL[k % PEAK_COL.length];
          series.push({x: xs, y: xs.map((x, i) => tr(pv(x, p) + bs[i])), color: col, width: 0.8, fill: hexA(col, .25), base: bt}); });
        series.push({x: xs, y: xs.map((x, i) => tr(F.peaks.reduce((a, p) => a + pv(x, p), 0) + bs[i])), color: '#111', width: 1.1});
      }
    } }
  const sel = C.find(c => c.s.id === S.sel), fr = sel && sel.s.fit.range;
  const yr = fill(LIMS.wf, C.length ? extent(vis, 0.06) : [0, 1]);
  WF = drawPlot(cv, 380, {xr, yr, series, xlabel: 'Binding energy (eV)', ylabel: 'Intensity (a.u.)',
    bands: fr && FITOPEN && !EXPORTING ? [{a: fr[0], b: fr[1], color: 'rgba(255,200,60,.10)'}] : [], vlines: PICK && !EXPORTING ? [{x: +S.shiftTarget, color: '#d62728'}] : [],
    drag: null});
  axisUI(cv, WF, 'wf', xr, yr);
  WF.curves = C;
}
function wfEvents() {
  const cv = $('#xwf_cv');
  const labAt = e => WF && !PICK ? (WF.labels || []).find(b => e.offsetX >= b.x0 && e.offsetX <= b.x1 && e.offsetY >= b.y0 && e.offsetY <= b.y1) : null;
  cv.addEventListener('pointerdown', e => { if (!WF) return; const X = e.offsetX, lb = labAt(e);
    wfDrag = lb ? {label: lb, gx: X - lb.cx, gy: e.offsetY - lb.by, X, Y: e.offsetY, moved: false} : {a: WF.ix(X), b: WF.ix(X), X, moved: false};
    cv.setPointerCapture(e.pointerId); });
  cv.addEventListener('pointermove', e => {
    if (!wfDrag) { cv.style.cursor = labAt(e) ? 'move' : ''; return; }
    if (Math.abs(e.offsetX - wfDrag.X) > 4 || (wfDrag.label && Math.abs(e.offsetY - wfDrag.Y) > 4)) wfDrag.moved = true;   // no drag-zoom: a drag is simply not a click
    if (wfDrag.label && wfDrag.moved) {          // drag a curve label: all labels move together
      const c = WF.curves.find(q => q.s.id === wfDrag.label.id); if (!c) return;
      const fx = Math.min(1, Math.max(0, (e.offsetX - wfDrag.gx - WF.L) / WF.pw)), xv = WF.ix(WF.L + fx * WF.pw);
      S.wf.lab = {fx: +fx.toFixed(4), dy: Math.round(e.offsetY - wfDrag.gy - WF.py(c.y[nearestIdx(c.x, xv)]))};
      drawWf(); cv.style.cursor = 'move';
    } });
  cv.addEventListener('pointerup', e => {
    const d = wfDrag; wfDrag = null; if (!d) return;
    if (d.moved) { if (d.label) commit('Move curve labels'); return; }
    // click: nearest curve at this x
    const x = WF.ix(e.offsetX); let best = null, bd = 1e9;
    for (const c of WF.curves) { const i = nearestIdx(c.x, x); const dy = Math.abs(WF.py(c.y[i]) - e.offsetY); if (dy < bd) { bd = dy; best = c; } }
    if (!best || bd > 40) return drawWf();
    if (PICK) {                                  // move the clicked point (nearest maximum within ±0.6 eV) to the target
      let i = nearestIdx(best.x, x), j = i; for (let k = 0; k < best.x.length; k++) if (Math.abs(best.x[k] - x) <= 0.6 && best.y[k] > best.y[j]) j = k;
      const sp = best.s, was = sp.shiftOn ? +sp.shift || 0 : 0;
      sp.shift = +(was + S.shiftTarget - best.x[j]).toFixed(2); sp.shiftOn = true; S.sel = sp.id; autoRange(sp); PCACHE.clear(); runFit(sp, {iters: 60});
      return commit(`${sp.name}: shift ${sp.shift} eV (point ${best.x[j].toFixed(2)} → ${+S.shiftTarget})`);
    }
    select(best.s.id);
  });
  cv.addEventListener('dblclick', () => { if (PICK) return; LIMS.x = [null, null]; LIMS.wf = [null, null]; redrawBoth(); });
}
function nearestIdx(xs, x) { let lo = 0, hi = xs.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; xs[m] < x ? lo = m : hi = m; } return Math.abs(xs[lo] - x) < Math.abs(xs[hi] - x) ? lo : hi; }

// ---------------- fitting window ----------------
function renderFitBar() {
  const sp = cur(), b = $('#xft_btns'), h = $('#xft_hint');
  $('#xft_title').innerHTML = sp ? `Fitting · <span style="color:${sp.color}">${esc(sp.name)}</span>` : 'Fitting';
  if (!sp) { b.innerHTML = ''; h.innerHTML = 'Load spectra first.'; return; }
  const fr = sp.fit.range;
  b.innerHTML = `<label>range <input type="number" id="xft_a" value="${fr ? +fr[0].toFixed(2) : ''}" step="0.1" style="width:72px"> – <input type="number" id="xft_b" value="${fr ? +fr[1].toFixed(2) : ''}" step="0.1" style="width:72px"> eV</label>
    <label title="A module sets the background, the range and a fixed list of peaks for one region of an NMC cathode">module <select id="xft_rule">${Object.entries(RULES).map(([k, v]) => `<option value="${k}" ${sp.fit.rule === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
  h.classList.toggle('hint', mode() === 'range');
  h.innerHTML = mode() === 'range' ? '<b>Drag across the plot</b> to choose the fitting range (or type it above). It need not match the view.'
    : 'Double-click: add a peak · drag a dot: move it · scroll: width · doublets: in the table · the whole scan is fitted; drag a dashed line to narrow the range';
  const rs = $('#xft_rule'); if (rs) rs.onchange = () => { const note = applyRule(sp, rs.value); commit(`${sp.name}: module ${RULES[sp.fit.rule]}`); if (note) msg(note); };
  for (const k of ['xft_a', 'xft_b']) { const el = $('#' + k); if (el) el.onchange = () => {
    const a = +$('#xft_a').value, c = +$('#xft_b').value; if (!isFinite(a) || !isFinite(c) || a === c) return;
    sp.fit.range = [Math.min(a, c), Math.max(a, c)]; sp.fit.auto = false; runFit(sp, {iters: 150}); commit(`${sp.name}: range ${sp.fit.range.map(v => v.toFixed(1)).join('–')} eV`); }; }
}
let FT = null, ftDrag = null, liveT = null, wheelT = null;
function drawFit() {
  const cv = $('#xft_cv'), sp = cur(); if (!cv || !FITOPEN || $('section[data-pane=xps]').hidden) return;
  if (!sp || !DATA[sp.id]) { const xr = xRange(), yr = fill(LIMS.fit, [0, 1]); FT = drawPlot(cv, 380, {xr, yr, series: [], xlabel: 'Binding energy (eV)', ylabel: 'Intensity (a.u.)'}); axisUI(cv, FT, 'fit', xr, yr); return; }
  const r = proc(sp), xr = xRange(), fr = sp.fit.range, P = sp.fit.peaks;
  const vi = [], vy = [], vb = []; for (let i = 0; i < r.x.length; i++) if (r.x[i] >= xr[0] && r.x[i] <= xr[1]) { vi.push(r.x[i]); vy.push(r.ds[i]); vb.push(r.base[i]); }
  const series = [], marks = [];
  if (fr && P.length) {
    sync(P);
    const xs = []; const st = (fr[1] - fr[0]) / 600; for (let x = fr[0]; x <= fr[1] + st / 2; x += st) xs.push(x);
    const bx = xs.map(x => baseAt(r, x));                                              // the peaks stand on the background
    P.forEach((p, k) => { const col = p.color || PEAK_COL[k % PEAK_COL.length], y = xs.map((x, i) => pv(x, p) + bx[i]);
      series.push({x: xs, y, color: col, width: 1, fill: hexA(col, p.id === ACTIVE && !EXPORTING ? .42 : .28), base: bx});
      marks.push({x: p.c, y: p.h + baseAt(r, p.c), color: col, text: p.c.toFixed(1), on: p.id === ACTIVE && !EXPORTING}); });
  }
  if (bgShown(sp)) series.push({x: vi, y: vb, color: '#555', width: 1, dash: [5, 4]});
  series.push({x: vi, y: vy, color: '#8a9099', points: 2.6});
  if (fr && P.length) { const xs = series[0].x; series.push({x: xs, y: xs.map(x => P.reduce((s, p) => s + pv(x, p), 0) + baseAt(r, x)), color: '#111', width: 1.6}); }
  let yr = extent([vy, ...series.filter(s => s.fill).map(s => s.y)], 0.05); yr = fill(LIMS.fit, [yr[0], yr[1] + (yr[1] - yr[0]) * .06]);
  const bands = [];
  if (fr && !EXPORTING) bands.push({a: fr[0], b: fr[1], color: mode() === 'range' ? 'rgba(255,190,40,.18)' : 'rgba(255,200,60,.09)', edge: '#e0a800'});
  FT = drawPlot(cv, 380, {xr, yr, series, marks, bands, xlabel: 'Binding energy (eV)', ylabel: 'Intensity (a.u.)',
    drag: ftDrag && ftDrag.kind !== 'peak' && ftDrag.moved ? {a: ftDrag.a, b: ftDrag.b, color: ftDrag.kind === 'range' ? 'rgba(255,190,40,.3)' : 'rgba(31,95,191,.12)'} : null});
  axisUI(cv, FT, 'fit', xr, yr);
  cv.style.cursor = mode() === 'range' ? 'col-resize' : mode() === 'fit' ? 'crosshair' : 'default';
}
const hexA = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function baseAt(r, x) { const i = nearestIdx(r.x, x); return r.base[i] || 0; }      // background under energy x
function hitPeak(e) {
  const sp = cur(); if (!sp || !FT || mode() !== 'fit') return null; let best = null, bd = 14;
  const r0 = proc(sp); for (const p of sp.fit.peaks) { const d = Math.hypot(FT.px(p.c) - e.offsetX, FT.py(p.h + baseAt(r0, p.c)) - e.offsetY); if (d < bd) { bd = d; best = p; } }
  return best;
}
function liveFit(fix) {                        // throttled quick refit of the other peaks while dragging / scrolling
  if (liveT) return; liveT = requestAnimationFrame(() => { liveT = null; const sp = cur(); runFit(sp, {iters: 12, fix}); drawFit(); renderSide(); });
}
function fitEvents() {
  const cv = $('#xft_cv');
  cv.addEventListener('pointerdown', e => {
    const sp = cur(); if (!sp || !FT) return;
    const p = hitPeak(e);
    const fr = sp.fit.range, ei = mode() === 'fit' && fr ? [0, 1].find(i => Math.abs(FT.px(fr[i]) - e.offsetX) < 6) : undefined;
    if (p) { ACTIVE = p.id; ftDrag = {kind: 'peak', p}; }
    else if (ei !== undefined) ftDrag = {kind: 'edge', i: ei};
    else if (mode() === 'range') ftDrag = {kind: 'range', a: FT.ix(e.offsetX), b: FT.ix(e.offsetX), X: e.offsetX, moved: false};
    else return;                                  // no drag-zoom
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', e => {
    const sp0 = cur(), fr0 = sp0 && sp0.fit.range;
    if (!ftDrag) { cv.style.cursor = hitPeak(e) ? 'grab' : mode() === 'fit' && fr0 && FT && fr0.some(v => Math.abs(FT.px(v) - e.offsetX) < 6) ? 'ew-resize' : mode() === 'range' ? 'col-resize' : mode() === 'fit' ? 'crosshair' : 'default'; return; }
    if (ftDrag.kind === 'peak') { const p = ftDrag.p, m = mainOf(sp0.fit.peaks, p);          // dragging the partner of a doublet moves its main peak
      const xv = FT.ix(e.offsetX), hv = Math.max(0, FT.iy(e.offsetY) - baseAt(proc(sp0), xv));              // height above the background
      if (m !== p) { m.c = xv - (+p.link.d || 0); m.h = hv / (+p.link.r || 1); } else { p.c = xv; p.h = hv; }
      cv.style.cursor = 'grabbing'; liveFit(m.id); return; }
    if (ftDrag.kind === 'edge') { const v = FT.ix(e.offsetX), o = fr0[1 - ftDrag.i]; sp0.fit.auto = false; fr0[ftDrag.i] = ftDrag.i ? Math.max(v, o + 0.5) : Math.min(v, o - 0.5);
      $('#xft_a').value = fr0[0].toFixed(2); $('#xft_b').value = fr0[1].toFixed(2); liveFit(null); return; }
    ftDrag.b = FT.ix(e.offsetX); if (Math.abs(e.offsetX - ftDrag.X) > 4) ftDrag.moved = true; drawFit();
  });
  cv.addEventListener('pointerup', () => {
    const d = ftDrag, sp = cur(); ftDrag = null; if (!d || !sp) return;
    if (d.kind === 'peak') { runFit(sp, {iters: 30, fix: mainOf(sp.fit.peaks, d.p).id}); commit(`${sp.name}: move ${d.p.name} to ${d.p.c.toFixed(2)}`); return; }
    if (d.kind === 'edge') { runFit(sp, {iters: 150}); return commit(`${sp.name}: fitting range ${sp.fit.range.map(v => v.toFixed(1)).join('–')} eV`); }
    if (!d.moved) { drawFit(); return; }
    const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
    if (d.kind === 'range') { sp.fit.range = [a, b]; sp.fit.auto = false; runFit(sp, {iters: 150}); commit(`${sp.name}: fitting range ${a.toFixed(1)}–${b.toFixed(1)} eV`); }
  });
  cv.addEventListener('dblclick', e => {
    const sp = cur(); if (!sp) return;
    if (mode() !== 'fit' || !sp.fit.range) { LIMS.x = [null, null]; LIMS.fit = [null, null]; redrawBoth(); return; }
    const x = FT.ix(e.offsetX), r = proc(sp), i = nearestIdx(r.x, x);
    const rest = r.y[i] - sp.fit.peaks.reduce((s, p) => s + pv(x, p), 0);
    const used = new Set(sp.fit.peaks.map(p => p.color)), col = PEAK_COL.find(c => !used.has(c)) || PEAK_COL[sp.fit.peaks.length % PEAK_COL.length];
    const p = {id: nid(), name: 'P' + (sp.fit.peaks.length + 1), c: x, w: 1.4, h: Math.max(rest, (r.y[i] || 0) * 0.3, 1e-6), eta: 0.2, etaFree: false, lock: false, color: col};
    sp.fit.peaks.push(p); ACTIVE = p.id;
    runFit(sp, {iters: 150});
    commit(`${sp.name}: add peak at ${x.toFixed(1)} eV`);
  });
  cv.addEventListener('wheel', e => {
    const sp = cur(); if (!sp || mode() !== 'fit' || !sp.fit.peaks.length || !FT) return;
    e.preventDefault();
    const x = FT.ix(e.offsetX); let p = sp.fit.peaks.reduce((a, b) => Math.abs(b.c - x) < Math.abs(a.c - x) ? b : a);
    ACTIVE = p.id; p = mainOf(sp.fit.peaks, p); p.w = Math.max(0.1, p.w * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    liveFit(p.id);
    clearTimeout(wheelT); wheelT = setTimeout(() => commit(`${sp.name}: ${p.name} width ${p.w.toFixed(2)}`), 500);
  }, {passive: false});
}
function delPeak(id) { const sp = cur(); if (!sp) return; const p = sp.fit.peaks.find(q => q.id === id); if (!p) return;
  sp.fit.peaks = sp.fit.peaks.filter(q => q !== p); for (const q of sp.fit.peaks) if (q.link && q.link.to === id) delete q.link;      // partners of a deleted main peak become free peaks
  for (const r of sp.fit.ratios) { r.num = r.num.filter(i => i !== id); r.den = r.den.filter(i => i !== id); }
  ACTIVE = null; runFit(sp, {iters: 150}); commit(`${sp.name}: delete ${p.name}`); }

// ---------------- side panel: peaks, R², ratios ----------------
const f1 = (v, d = 1) => isFinite(v) ? (+v).toFixed(d) : '';
const limTxt = (p, k) => { const l = lim(p, k); return !l ? 'free' : l[0] === l[1] ? 'fixed at ' + l[0] : `limits ${l[0]}–${l[1]}`; };
function renderSide() {
  const sp = cur(), box = $('#xft_side'); if (!box) return;
  if (!sp) { box.innerHTML = ''; return; }
  const P = sp.fit.peaks; sync(P); const st = fitStats(sp), tot = P.reduce((s, p) => s + area(p), 0);
  const dbl = p => p.link ? `<span class="gmuted" title="Partner of ${esc((P.find(q => q.id === p.link.to) || {}).name || '')}: position = main + Δ, area = main × ratio, same width and shape">Δ</span> <input data-f="ld" type="number" step="0.05" value="${+(+p.link.d).toFixed(3)}" style="width:62px"> <span class="gmuted">×</span> <input data-f="lr" type="number" step="0.01" min="0" value="${+(+p.link.r).toFixed(4)}" style="width:58px"> <span class="x" data-unlink title="Make it a free peak again">⛓</span>`
    : P.some(q => q.link && q.link.to === p.id) ? '<span class="gmuted">main</span>'
    : `<select data-f="mk" title="Add a spin-orbit partner at higher binding energy; its area ratio is fixed by the orbital"><option value="">+ doublet…</option><option value="0.5">p (2:1)</option><option value="0.6667">d (3:2)</option><option value="0.75">f (4:3)</option></select>`;
  const focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : null;
  box.innerHTML = `
    <div class="r2">R² = <b>${st ? st.r2.toFixed(4) : '—'}</b>${sp.fit.weight ? ` <span class="gmuted">· residuals weighted ×${sp.fit.weight.w} in ${sp.fit.weight.a}–${sp.fit.weight.b} eV</span>` : ''}</div>
    <table class="pk"><thead><tr><th></th><th>Peak</th><th title="Peak position">Center</th><th title="Full width at half maximum">FWHM</th>
      <th title="Lorentzian fraction: 0 = pure Gaussian, 100 = pure Lorentzian; tick = let the fit change it">L % · fit</th><th>Height</th><th>Area</th><th>%</th><th title="Signal-to-noise ratio: peak height ÷ noise. Noise = standard deviation of (intensity − background − fit) in the fit range">S/N</th><th title="Spin-orbit doublet: Δ = splitting in eV, × = area ratio partner ÷ main">Doublet</th><th title="Lock position and width">🔒</th><th></th></tr></thead>
    <tbody>${P.map((p, k) => `<tr data-id="${p.id}" class="${p.id === ACTIVE ? 'on' : ''}">
      <td><span class="sw" style="background:${p.color}"></span></td>
      <td><input data-f="name" value="${esc(p.name)}" class="nm"></td>
      <td><input data-f="c" type="number" step="0.05" value="${f1(p.c, 2)}" title="${p.link ? 'follows the main peak' : limTxt(p, 'c')}" class="${lim(p, 'c') ? 'lk' : ''}" ${p.link ? 'disabled' : ''}></td>
      <td><input data-f="w" type="number" step="0.05" value="${f1(p.w, 2)}" title="${p.link ? 'follows the main peak' : limTxt(p, 'w')}" class="${lim(p, 'w') ? 'lk' : ''}" ${p.link ? 'disabled' : ''}></td>
      <td><input data-f="eta" type="number" step="5" min="0" max="100" value="${f1(p.eta * 100, 0)}" title="${p.etaFree ? 'fitted' : 'fixed'}${lim(p, 'eta') ? ' · ' + limTxt(p, 'eta') : ''}" ${p.link ? 'disabled' : ''}><label class="ef" title="Let the fit change L %"><input type="checkbox" data-f="etaFree" ${p.etaFree ? 'checked' : ''} ${p.link ? 'disabled' : ''}></label></td>
      <td class="ro">${tfmt(+p.h.toPrecision(4))}</td><td class="ro">${tfmt(+area(p).toPrecision(4))}</td><td class="ro">${tot ? (100 * area(p) / tot).toFixed(1) : ''}</td><td class="ro">${snrTxt(snr(p, st))}</td><td class="dbl">${dbl(p)}</td>
      <td><input type="checkbox" data-f="lock" ${p.lock ? 'checked' : ''} ${p.link ? 'disabled' : ''}></td><td><span class="x" title="Delete peak">✕</span></td></tr>`).join('')}</tbody></table>
    ${P.length ? '' : `<div class="gmuted" style="padding:6px 2px">${mode() === 'fit' ? 'Double-click on the plot to add the first peak.' : 'Choose the fitting range first.'}</div>`}
    <div class="ratios"><div class="rh">Area ratios <button type="button" id="xrt_add" ${P.length ? '' : 'disabled'}>+ ratio</button></div>
      ${sp.fit.ratios.map((r, i) => ratioHtml(sp, r, i)).join('')}</div>`;
  box.querySelectorAll('tr[data-id]').forEach(tr => {
    const p = P.find(q => q.id === tr.dataset.id);
    tr.onclick = () => { if (ACTIVE !== p.id) { ACTIVE = p.id; drawFit(); box.querySelectorAll('tr').forEach(t => t.classList.toggle('on', t === tr)); } };
    tr.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      if (f === 'mk') { inp.onchange = () => { const r = +inp.value; if (!r) return;                 // add the spin-orbit partner of this peak
          const used = new Set(P.map(q => q.color)), col = PEAK_COL.find(c => !used.has(c)) || PEAK_COL[P.length % PEAK_COL.length];
          const q = {id: nid(), name: p.name + '′', c: p.c + 1, w: p.w, h: p.h * r, eta: p.eta, etaFree: false, lock: false, color: col, link: {to: p.id, d: 1, r}};
          P.splice(P.indexOf(p) + 1, 0, q); ACTIVE = q.id; runFit(sp, {iters: 150}); commit(`${sp.name}: doublet partner for ${p.name} (set Δ in the table)`); }; return; }
      const apply = () => { if (f === 'name') p.name = inp.value.trim() || p.name; else if (f === 'etaFree' || f === 'lock') p[f] = inp.checked;
        else { const v = +inp.value; if (!isFinite(v)) return; if (f === 'ld') p.link.d = v; else if (f === 'lr') p.link.r = Math.max(0, v);
          else if (f === 'eta') p.eta = Math.min(1, Math.max(0, v / 100)); else if (f === 'w') p.w = Math.max(0.1, v); else p[f] = v; } };
      const hold = () => { if (f === 'ld' || f === 'lr') runFit(sp, {iters: 150}); else if (f === 'c' || f === 'w' || f === 'eta') { const l = p.lock, e = p.etaFree; p.lock = true; p.etaFree = false; runFit(sp, {iters: 40}); p.lock = l; p.etaFree = e; } else if (f !== 'name') runFit(sp, {iters: 150}); };
      if (inp.type === 'number') inp.oninput = () => { apply(); hold(); drawFit(); };   // live: the typed value is kept, the rest refits
      inp.onchange = () => { apply(); hold(); commit(`${sp.name}: ${p.name} ${f} ${inp.type === 'checkbox' ? inp.checked : inp.value}`); };
    });
    tr.querySelector('td:last-child .x').onclick = e => { e.stopPropagation(); delPeak(p.id); };
    const ul = tr.querySelector('[data-unlink]'); if (ul) ul.onclick = e => { e.stopPropagation(); delete p.link; runFit(sp, {iters: 150}); commit(`${sp.name}: ${p.name} is a free peak again`); };
  });
  const add = $('#xrt_add'); if (add) add.onclick = () => { sp.fit.ratios.push({num: P[0] ? [P[0].id] : [], den: P.map(p => p.id)}); commit(`${sp.name}: add ratio`); };
  box.querySelectorAll('.ratio').forEach(div => { const r = sp.fit.ratios[+div.dataset.i];
    div.querySelectorAll('[data-pk]').forEach(b => b.onclick = () => { const L = r[b.dataset.side], id = b.dataset.pk;
      L.includes(id) ? L.splice(L.indexOf(id), 1) : L.push(id); commit(`${sp.name}: ratio ${+div.dataset.i + 1} ${b.dataset.side} ${b.textContent}`); });
    div.querySelector('.x').onclick = () => { sp.fit.ratios.splice(+div.dataset.i, 1); commit(`${sp.name}: remove ratio`); };
  });
}
function ratioVal(sp, r) { const A = id => { const p = sp.fit.peaks.find(q => q.id === id); return p ? area(p) : 0; };
  const n = r.num.reduce((s, i) => s + A(i), 0), d = r.den.reduce((s, i) => s + A(i), 0); return d ? n / d : NaN; }
function ratioName(sp, r) { const nm = ids => { const L = ids.map(i => (sp.fit.peaks.find(p => p.id === i) || {}).name).filter(Boolean); return L.length > 1 ? '(' + L.join('+') + ')' : L[0] || '?'; };
  return nm(r.num) + ' / ' + nm(r.den); }
function ratioHtml(sp, r, i) {
  const pills = side => sp.fit.peaks.map(p => `<button type="button" class="pill${r[side].includes(p.id) ? ' on' : ''}" data-side="${side}" data-pk="${p.id}" style="--c:${p.color}">${esc(p.name)}</button>`).join('');
  const v = ratioVal(sp, r);
  return `<div class="ratio" data-i="${i}"><div class="rv"><span>${esc(ratioName(sp, r))}</span><b>${isFinite(v) ? v.toFixed(3) : '—'}</b><span class="x" title="Remove ratio">✕</span></div>
    <div class="frac"><div class="nr">${pills('num')}</div><div class="dr">${pills('den')}</div></div></div>`;
}

// ---------------- history list ----------------
function showHist() {
  let d = $('#xr_hdlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'xr_hdlg'; d.className = 'small'; document.body.appendChild(d); }
  d.innerHTML = `<div class="eh"><span>Steps (click one to go back to it)</span><button type="button" id="xrh_x">✕</button></div>
    <div class="sb" style="max-height:60vh;overflow:auto">${HIST.map((h, i) => `<div class="hrow${i === HPOS ? ' on' : ''}${i > HPOS ? ' fut' : ''}" data-i="${i}">
      <span class="gmuted">${i}</span> ${esc(h.label)} <span class="gmuted" style="margin-left:auto">${h.t.slice(11, 19)}</span></div>`).reverse().join('')}</div>`;
  d.querySelectorAll('.hrow').forEach(r => r.onclick = () => { jump(+r.dataset.i); showHist(); });
  $('#xrh_x', d).onclick = () => d.close(); if (!d.open) d.showModal();
}

// ---------------- saving ----------------
let saveT = null, DIR = null, lastSaved = '';
function project() { return {app: 'CellPeek XPS', version: (window.NQP_CONFIG || {}).APP_VERSION, saved: new Date().toISOString(), state: S,
  steps: HIST.map(h => ({t: h.t, label: h.label})), data: Object.fromEntries(S.spectra.map(s => [s.id, DATA[s.id]]))}; }
function autosave() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await idb().set('xps', {S, DATA: Object.fromEntries(Object.entries(DATA).filter(([k]) => HIST.some(h => h.s.includes(k)))), HIST, HPOS}); } catch {}
    if (DIR) try {
      const fh = await DIR.getFileHandle('CellPeek_XPS_project.json', {create: true}), w = await fh.createWritable();
      await w.write(JSON.stringify(project())); await w.close(); lastSaved = new Date().toTimeString().slice(0, 8);
    } catch (e) { lastSaved = 'error: ' + e.message; }
    else lastSaved = new Date().toTimeString().slice(0, 8);
    saveLabel();
  }, 800);
}
function saveLabel() {
  const el = $('#xr_save'); if (!el) return;
  el.innerHTML = (DIR ? `Auto-saved ${esc(lastSaved)} → <b>${esc(DIR.name)}</b> <a href="#" id="xr_dir">change</a>`
    : `Auto-saved in this browser ${esc(lastSaved)} · <a href="#" id="xr_dir" class="srcneed" title="Choose a folder, e.g. in Google Drive, for the project file and exports">save to folder…</a>`);
  $('#xr_dir').onclick = async e => { e.preventDefault();
    try { DIR = await window.showDirectoryPicker({id: 'cellpeek-xps', mode: 'readwrite'}); await idb().set('xps_dir', DIR); autosave(); } catch {} };
}
function loadProject(p) {
  if (!p || !p.state || !p.data || p.app !== 'CellPeek XPS') throw new Error('not a CellPeek XPS project');
  DATA = {...DATA, ...p.data}; S = p.state; PCACHE.clear();
  HIST = []; HPOS = -1; commit('Open project (' + (p.saved || '').slice(0, 16).replace('T', ' ') + ')');
}
async function restore() {
  try { const r = await idb().get('xps'); if (r && r.S) { DATA = r.DATA || {}; S = r.S; HIST = r.HIST || []; HPOS = r.HPOS ?? HIST.length - 1; } } catch {}
  if (!HIST.length) { HIST = [{s: JSON.stringify(S), label: 'Start', t: new Date().toISOString()}]; HPOS = 0; }
  try { const h = await idb().get('xps_dir'); if (h && (await h.queryPermission({mode: 'readwrite'})) === 'granted') DIR = h; } catch {}
  saveLabel();
}

// ---------------- export ----------------
const num = v => String(+(+v).toPrecision(7));
function exportFiles() {
  const files = [], sum = [['spectrum', 'peak', 'center (eV)', 'fwhm (eV)', 'L_percent', 'height', 'area', 'area_percent', 'SNR', 'doublet', 'R2', 'range_from (eV)', 'range_to (eV)'].join('\t')];
  for (const sp of S.spectra) {
    const r = proc(sp); if (!r) continue; const base = sp.name.replace(/[\\/:*?"<>|]/g, '_');
    files.push([base + '_spectrum.txt', 'Binding energy (eV)\tintensity (c/s)\tbackground\tintensity minus background\n' + r.x.map((x, i) => [x, r.ds[i], r.base[i], r.y[i]].map(num).join('\t')).join('\n') + '\n']);
    if (sp.fit.range && sp.fit.peaks.length) {
      const P = sp.fit.peaks; sync(P); const {x, y} = inRange(sp), st = fitStats(sp), tot = P.reduce((s, p) => s + area(p), 0);
      files.push([base + '_fit.txt', ['Binding energy (eV)\tintensity\tbackground\tbackground + fit\t' + P.map(p => p.name + ' (above background)').join('\t'),
        ...x.map((xx, i) => { const c = P.map(p => pv(xx, p)), bb = baseAt(r, xx); return [xx, y[i] + bb, bb, c.reduce((a, b) => a + b, 0) + bb, ...c].map(num).join('\t'); })].join('\n') + '\n']);
      const lines = ['peak\tcenter (eV)\tfwhm (eV)\tL_percent\theight\tarea\tarea_percent\tSNR\tdoublet'];
      for (const p of P) { const row = [p.name, num(p.c), num(p.w), num(p.eta * 100), num(p.h), num(area(p)), num(100 * area(p) / tot), num(snr(p, st)), p.link ? `partner of ${(P.find(q => q.id === p.link.to) || {}).name}: +${p.link.d} eV, area x ${p.link.r}` : ''];
        lines.push(row.join('\t')); sum.push([sp.name, ...row, num(st.r2), num(sp.fit.range[0]), num(sp.fit.range[1])].join('\t')); }
      lines.push('', 'R2\t' + num(st.r2), 'noise\t' + num(st.noise) + '\tstandard deviation of (intensity - background - fit) in the fit range; SNR = peak height / noise', 'range\t' + num(sp.fit.range[0]) + '\t' + num(sp.fit.range[1]));
      for (const q of sp.fit.ratios) lines.push(ratioName(sp, q) + '\t' + num(ratioVal(sp, q)));
      lines.push('', 'module\t' + (RULES[sp.fit.rule] || sp.fit.rule), 'weight\t' + (sp.fit.weight ? `x${sp.fit.weight.w} in ${sp.fit.weight.a}-${sp.fit.weight.b}` : 'none'),
        'background\t' + (bgShown(sp) ? `${sp.bg.kind || 'shirley'}, ends = mean of ${+sp.bg.navg || 1} points, ${sp.bg.a != null && sp.bg.b != null ? `window ${sp.bg.a}-${sp.bg.b} eV` : 'whole spectrum'}${(sp.bg.cuts || []).length ? ', split at ' + sp.bg.cuts.join(', ') + ' eV (one background for each part)' : ''}; peaks fitted to intensity minus background` : 'none'),
        'peak shape\tGaussian-Lorentzian sum (pseudo-Voigt), L_percent = Lorentzian share', 'charge correction (eV)\t' + (sp.shiftOn ? sp.shift + ' (strongest C 1s peak of the file moved to ' + C_REF + ' eV)' : 'none'));
      files.push([base + '_peaks.txt', lines.join('\n') + '\n']);
    }
  }
  if (sum.length > 1) files.push(['peaks_summary.txt', sum.join('\n') + '\n']);
  return files;
}
async function exportAll() {
  if (!S.spectra.length) return msg('Nothing to export yet.');
  const files = exportFiles(), stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1_');
  if (DIR) {
    try { const sub = await DIR.getDirectoryHandle('export_' + stamp, {create: true});
      for (const [n, t] of files) { const w = await (await sub.getFileHandle(n, {create: true})).createWritable(); await w.write(t); await w.close(); }
      msg(`Exported ${files.length} files to ${DIR.name}/export_${stamp}`); } catch (e) { msg('Export failed: ' + e.message); }
  } else {
    for (const [n, t] of files) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], {type: 'text/plain'})); a.download = n; a.click(); URL.revokeObjectURL(a.href); }
    msg(`Downloaded ${files.length} files (choose a save folder to write them there instead)`);
  }
  if (window.NQP && NQP.log) NQP.log('xps_export', {n: files.length});
}
function savePng(which) {
  const cv = $(which === 'wf' ? '#xwf_cv' : '#xft_cv'), sp = cur(), redraw = which === 'wf' ? drawWf : drawFit;
  EXPORTING = true; try { redraw(); } finally { EXPORTING = false; }      // the PNG is the plot as it is on screen: same range, same proportions, same labels and label positions
  const F = which === 'wf' ? WF : FT, cut = F ? Math.max(0, Math.round((F.L - 36) * (cv.width / (parseFloat(cv.style.width) || cv.width)))) : 0;   // empty left margin (room for the axis-end boxes on screen)
  const c2 = document.createElement('canvas'); c2.width = cv.width - cut; c2.height = cv.height; const g = c2.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c2.width, c2.height); g.drawImage(cv, -cut, 0);
  const a = document.createElement('a'); a.href = c2.toDataURL('image/png'); a.download = (which === 'wf' ? 'xps_spectra' : 'xps_fit_' + (sp ? sp.name : '')) + '.png'; a.click();
  redraw();
}

// ---------------- start ----------------
window.addEventListener('DOMContentLoaded', async () => {
  build(); await restore(); render();
  window.addEventListener('cellpeek:tab', () => render());
});
NQP.xps = {parseSpe, wf: () => WF, addText: (name, text) => addFiles([new File([text], name)]), state: () => S, fitNow: () => { runFit(cur(), {iters: 300}); commit('fit'); }};
})();
