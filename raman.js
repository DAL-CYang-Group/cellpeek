// CellPeek — Raman Fitting tab.
// Waterfall of all loaded spectra (despike + background removal there), fitting window for the selected one.
// Every change is a step in the history (Undo / Redo); the project is auto-saved in the browser and,
// if a save folder is chosen (e.g. a Google Drive folder), to CellPeek_Raman_project.json in that folder.
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
let S = {spectra: [], sel: null, wf: {offset: 1, norm: true, view: 'corrected'}, shiftTarget: 594};
let HIST = [], HPOS = -1;                      // HIST[i] = {s: JSON of S, label, t}
let FITOPEN = false, PICK = false;             // fitting panel shown? · picking shift points on the waterfall?
const mode = () => !FITOPEN ? 'off' : (cur() && cur().fit.range ? 'fit' : 'range');
const VIEW = {wf: null, fit: {}};              // x zoom (not part of history)
let ACTIVE = null;                             // id of the peak last touched
let uid = Date.now() % 1e6;
const nid = () => (++uid).toString(36);

const cur = () => S.spectra.find(s => s.id === S.sel) || null;
function newSpec(name, id) {
  return {id, name, color: SPEC_COL[S.spectra.length % SPEC_COL.length], show: true,
    despike: {on: false, thr: 40}, bg: {method: 'none', lam: 1e5, applied: false}, zero: {on: false, mode: 'auto', a: 700, b: 730}, shift: 0, shiftOn: false,
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
async function addFiles(files) {
  let n = 0, last = null; const bad = [];
  for (const f of files) {
    if (/\.json$/i.test(f.name)) { try { loadProject(JSON.parse(await f.text())); } catch (e) { bad.push(f.name + ': ' + e.message); } continue; }
    try {
      const d = parseTxt(await f.text()), id = nid();
      DATA[id] = d; const sp = newSpec(f.name.replace(/\.(txt|csv|dat)$/i, ''), id); sp.file = f.name;
      if (S.spectra[0]) { const q = S.spectra[0]; sp.despike = {...q.despike}; sp.bg = {...q.bg}; sp.zero = {...q.zero}; }
      S.spectra.push(sp); last = id; n++;
    } catch (e) { bad.push(f.name + ': ' + e.message); }
  }
  if (last) { S.sel = last; }
  if (n) commit(`Load ${n} file${n > 1 ? 's' : ''}`);
  msg(bad.length ? 'Not loaded: ' + bad.join('; ') : n ? `${n} ${n > 1 ? 'spectra' : 'spectrum'} loaded` : '');
  if (n && window.NQP && NQP.log) NQP.log('raman_load', {n});
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
function arpls(y, lam, ratio = 1e-2, niter = 50) {   // Baek et al., Analyst 2015, 140, 250 — banded Cholesky of (W + λ D'D)
  const n = y.length; let w = new Float64Array(n).fill(1), z = new Float64Array(n);
  const P0 = new Float64Array(n), P1 = new Float64Array(n), P2 = new Float64Array(n);   // bands of D'D
  for (let r = 0; r < n - 2; r++) { const c = [1, -2, 1];
    for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) { const i = r + b, d = b - a, v = c[a] * c[b]; (d === 0 ? P0 : d === 1 ? P1 : P2)[i] += v; } }
  const L0 = new Float64Array(n), L1 = new Float64Array(n), L2 = new Float64Array(n), u = new Float64Array(n);
  for (let it = 0; it < niter; it++) {
    for (let i = 0; i < n; i++) {
      const a0 = w[i] + lam * P0[i], a1 = i >= 1 ? lam * P1[i] : 0, a2 = i >= 2 ? lam * P2[i] : 0;
      L2[i] = i >= 2 ? a2 / L0[i - 2] : 0;
      L1[i] = i >= 1 ? (a1 - L2[i] * (i >= 2 ? L1[i - 1] : 0)) / L0[i - 1] : 0;
      L0[i] = Math.sqrt(Math.max(1e-300, a0 - L1[i] * L1[i] - L2[i] * L2[i]));
    }
    for (let i = 0; i < n; i++) u[i] = (w[i] * y[i] - (i >= 1 ? L1[i] * u[i - 1] : 0) - (i >= 2 ? L2[i] * u[i - 2] : 0)) / L0[i];
    for (let i = n - 1; i >= 0; i--) z[i] = (u[i] - (i + 1 < n ? L1[i + 1] * z[i + 1] : 0) - (i + 2 < n ? L2[i + 2] * z[i + 2] : 0)) / L0[i];
    let sm = 0, sq = 0, k = 0; for (let i = 0; i < n; i++) { const d = y[i] - z[i]; if (d < 0) { sm += d; sq += d * d; k++; } }
    if (!k) break;
    const m = sm / k, sd = Math.sqrt(Math.max(sq / k - m * m, 1e-300));   // population std, as numpy
    const wt = new Float64Array(n); let num = 0, den = 0;
    for (let i = 0; i < n; i++) { const d = y[i] - z[i]; wt[i] = 1 / (1 + Math.exp(Math.min(50, Math.max(-50, 2 * (d - (2 * sd - m)) / sd)))); num += (w[i] - wt[i]) ** 2; den += w[i] ** 2; }
    w = wt; if (Math.sqrt(num / den) < ratio) break;
  }
  return Array.from(z);
}
// background is two steps: 'arpls' + applied:false = baseline only shown (dashed) on the original spectrum, λ can be chosen;
// applied:true = baseline subtracted (projects saved before this have no flag and count as subtracted)
const bgShown = sp => sp.bg.method === 'arpls', bgDone = sp => sp.bg.method === 'arpls' && sp.bg.applied !== false;
const ZERO_W = 30;                              // width of the noise segment used for the zero level, cm⁻¹
const zeroOn = sp => !!sp.zero && (sp.zero.on || sp.zero.mode === undefined);   // projects saved before the Zero row always applied their window
const PCACHE = new Map();
function proc(sp) {
  const key = sp.id + JSON.stringify([sp.despike, sp.bg, sp.zero, sp.shift, sp.shiftOn]);
  if (PCACHE.has(key)) return PCACHE.get(key);
  const d = DATA[sp.id]; if (!d) return null;
  const ds = sp.despike.on ? despike(d.y, +sp.despike.thr || 40) : {y: Float64Array.from(d.y), n: 0};
  const b = sp.bg, ys = Array.from(ds.y);
  const base = b.method === 'arpls' ? arpls(ys, +b.lam || 1e5) : ys.map(() => 0);
  const done = bgDone(sp);
  let y = done ? ys.map((v, i) => v - base[i]) : ys.slice();
  const sh = sp.shiftOn ? +sp.shift || 0 : 0, x = d.x.map(v => v + sh);
  // zero level (after the background is removed): mean of a noise segment is set to 0.
  //   auto   — the first and the last ZERO_W cm⁻¹ of the spectrum are both tried; the one with the lower mean is used
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
function freeKeys(p) {
  const K = [];
  for (const k of ['c', 'w']) { const L = lim(p, k); if (!p.lock && !(L && L[0] === L[1])) K.push(k); }
  K.push('h');
  const L = lim(p, 'eta'); if (p.etaFree && !(L && L[0] === L[1])) K.push('eta');
  return K;
}
function clampP(p, x0, x1) {
  const L = k => lim(p, k);
  p.w = Math.min(Math.max(p.w, 0.5), (x1 - x0) * 3); p.h = Math.max(0, p.h); p.eta = Math.min(1, Math.max(0, p.eta));
  p.c = Math.min(Math.max(p.c, x0 - 30), x1 + 30);
  for (const k of ['c', 'w', 'eta']) { const l = L(k); if (l) p[k] = Math.min(Math.max(p[k], l[0]), l[1]); }
}
function lm(x, y, peaks, {iters = 100, fix = null, wt = null} = {}) {      // Levenberg–Marquardt, optional weights wt[i]
  const P = [];
  for (const p of peaks) if (p.id !== fix) for (const k of freeKeys(p)) P.push([p, k]);
  const n = x.length, m = P.length; if (!m || n < m) return Infinity;
  const sw = wt ? wt.map(Math.sqrt) : null, x0 = x[0], x1 = x[n - 1];
  const model = () => { const f = new Float64Array(n); for (const p of peaks) for (let i = 0; i < n; i++) f[i] += pv(x[i], p); return f; };
  const sse = f => { let s = 0; for (let i = 0; i < n; i++) { const r = (y[i] - f[i]) * (sw ? sw[i] : 1); s += r * r; } return s; };
  let f = model(), s0 = sse(f), lam = 1e-3;
  for (let it = 0; it < iters; it++) {
    const J = P.map(([p, k]) => { const v = p[k], d = k === 'eta' ? 1e-3 : Math.max(Math.abs(v) * 1e-5, 1e-5), c = new Float64Array(n);
      for (let i = 0; i < n; i++) c[i] = -pv(x[i], p); p[k] = v + d; for (let i = 0; i < n; i++) c[i] = (c[i] + pv(x[i], p)) / d * (sw ? sw[i] : 1); p[k] = v; return c; });
    const A = Array.from({length: m}, () => new Array(m).fill(0)), g = new Array(m).fill(0);
    for (let a = 0; a < m; a++) { for (let i = 0; i < n; i++) g[a] += J[a][i] * (y[i] - f[i]) * (sw ? sw[i] : 1);
      for (let b = a; b < m; b++) { let s = 0; for (let i = 0; i < n; i++) s += J[a][i] * J[b][i]; A[a][b] = A[b][a] = s; } }
    let ok = false;
    for (let t = 0; t < 10; t++) {
      const B = A.map((r, i) => r.map((v, j) => i === j ? v * (1 + lam) + 1e-12 : v)), dlt = solve(B, g); if (!dlt) { lam *= 10; continue; }
      const old = peaks.map(p => ({...p}));
      P.forEach(([p, k], i) => { p[k] += dlt[i]; }); for (const p of peaks) if (p.id !== fix) clampP(p, x0, x1);
      const f2 = model(), s2 = sse(f2);
      if (s2 < s0) { const rel = (s0 - s2) / (s0 || 1); f = f2; s0 = s2; lam = Math.max(lam / 3, 1e-9); ok = true; if (rel < 1e-10) it = iters; break; }
      peaks.forEach((p, i) => Object.assign(p, old[i])); lam *= 4;
    }
    if (!ok) break;
  }
  return s0;
}
function fitStats(sp) {
  if (!sp.fit.range || !sp.fit.peaks.length) return null;
  const {x, y} = inRange(sp); if (!x.length) return null;
  let mean = 0; for (const v of y) mean += v; mean /= y.length;
  let ss = 0, st = 0; for (let i = 0; i < x.length; i++) { let f = 0; for (const p of sp.fit.peaks) f += pv(x[i], p); ss += (y[i] - f) ** 2; st += (y[i] - mean) ** 2; }
  return {r2: 1 - ss / st};
}
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
      if (freeKeys(q).includes('c')) { const l = L('c'); q.c = l ? rnd(l[0], l[1]) : q.c + rnd(-8, 8); }
      if (freeKeys(q).includes('w')) { const l = L('w'); q.w = l ? rnd(l[0], l[1]) : q.w * rnd(0.75, 1.3); }
      if (freeKeys(q).includes('eta')) { const l = L('eta') || [0, 1]; q.eta = rnd(l[0], l[1]); }
      q.h = rnd(0.2, 1) * ymax; return q; });
    const sc = lm(x, y, T, {...opt, wt}); if (sc < bs) { bs = sc; best = T; }
  }
  best.forEach((q, i) => Object.assign(P[i], q));
  return bs;
}

// ---------------- rule presets (NMC cathode, see 软件实现说明 §6) ----------------
const RCOL = {bg: '#8c8c8c', E: '#2ca02c', P: '#1f77b4', A: '#d62728'};
function rulePeaks(rule) {
  const pk = (key, name, c, w, eta, L, etaFree = false) => ({id: nid(), key, name, c, w, h: 1, eta, etaFree, lock: false, color: RCOL[key], lim: L});
  const bg = pk('bg', 'TM-disorder', 420, 70, 0, {c: [414, 432], w: [40, 90], eta: [0, 0]});
  const E = pk('E', 'Eg', 480, 70, 0, {c: [455, 515], w: [30, 110], eta: [0, 0]});
  const P = pk('P', 'A1g′', 540, 35, 0, {c: [537, 544], w: [28, 55], eta: [0, 0]});
  const A = pk('A', 'A1g', 592, 73, 0.343, {c: [588, 594], w: [73, 73], eta: [0.343, 0.343]});
  if (rule === 'C120' || rule === 'CA') bg.lim.w = [40, 120];
  if (rule === 'C410') bg.lim.c = [410, 419];
  if (rule === 'CA') { A.lim = {c: [590, 598], w: [68, 78], eta: [0, 1]}; A.etaFree = true; }
  return [bg, E, P, A];
}
const RULES = {manual: 'Manual peaks', LE: 'LE', C: 'C', C120: 'C120', C410: 'C410 (trial)', CA: 'CA'};
function applyRule(sp, rule) {
  sp.fit.rule = rule;
  if (rule === 'manual') { sp.fit.weight = null; return; }
  sp.fit.range = [315, 730]; sp.fit.weight = {a: 575, b: 610, w: 5}; sp.zero = {on: true, mode: 'manual', a: 700, b: 730};   // §6.1: zero = 700–730 for the NMC rules (shown in the Zero row, can be changed there)
  if (!sp.shiftOn || !sp.shift) { const v = alignA1g(sp); if (v != null) { sp.shift = v; sp.shiftOn = true; } }          // §6.1: align A1g to 594 first (shift is recorded)
  sp.fit.peaks = rulePeaks(rule);
  const r = proc(sp); for (const p of sp.fit.peaks) { const i = nearestIdx(r.x, p.c); p.h = Math.max(r.y[i] * 0.6, 1e-6); }
  const id = k => sp.fit.peaks.find(p => p.key === k).id;
  sp.fit.ratios = [{num: [id('P')], den: [id('P'), id('A')]}, {num: [id('A')], den: [id('A'), id('E')]}];
  LIMS.x = [200, 800];
  runFit(sp, {iters: 200, starts: 12});
}
function alignA1g(sp) {                        // fit only A1g in 575–615 (FW 73, η 0.343 fixed) and shift so A1g = 594
  const old = sp.shiftOn; sp.shiftOn = false; const r = proc(sp); sp.shiftOn = old;
  const x = [], y = []; for (let i = 0; i < r.x.length; i++) if (r.x[i] >= 575 && r.x[i] <= 615) { x.push(r.x[i]); y.push(r.y[i]); }
  if (x.length < 5) return null;
  const p = {id: 'a', c: x[y.indexOf(Math.max(...y))], w: 73, h: Math.max(...y), eta: 0.343, lim: {w: [73, 73], eta: [0.343, 0.343], c: [570, 620]}};
  lm(x, y, [p], {iters: 200});
  return Math.round(594 - p.c);
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
  const px = x => L + (x - x0) / (x1 - x0) * pw, py = y => T + (1 - (y - y0) / (y1 - y0)) * ph;
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
    if (s.fill) { g.fillStyle = s.fill; g.beginPath(); g.moveTo(px(s.x[0]), py(s.base || 0));
      for (let i = 0; i < n; i++) g.lineTo(px(s.x[i]), py(s.y[i])); g.lineTo(px(s.x[n - 1]), py(s.base || 0)); g.closePath(); g.fill(); }
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
  for (const z of o.drag ? [o.drag] : []) { g.fillStyle = z.color; g.fillRect(px(Math.min(z.a, z.b)), T, Math.abs(px(z.b) - px(z.a)), ph); }
  g.restore();
  g.strokeStyle = '#c9ced5'; g.strokeRect(L + .5, T + .5, pw, ph);
  g.beginPath(); for (const t of xt) { const X = Math.round(px(t)) + .5; if (X > L + 1 && X < L + pw - 1) { g.moveTo(X, T + ph); g.lineTo(X, T + ph - 5); } } g.stroke();
  return {px, py, ix: X => x0 + (X - L) / pw * (x1 - x0), iy: Y => y0 + (1 - (Y - T) / ph) * (y1 - y0), L, T, pw, ph, labels};
}
const extent = (arrs, pad = 0.04) => { let a = Infinity, b = -Infinity; for (const r of arrs) for (const v of r) { if (v < a) a = v; if (v > b) b = v; }
  if (!isFinite(a)) return [0, 1]; const d = (b - a) || 1; return [a - d * pad, b + d * pad]; };

// ---------------- axis limits (typed, as in the cycling tab) ----------------
// One x range for both plots: the waterfall sets it and the fitting plot follows. y is separate for each plot.
const LIMS = {x: [null, null], wf: [null, null], fit: [null, null]};
const fill = (lim, auto) => { let a = lim[0] ?? auto[0], b = lim[1] ?? auto[1]; if (!(b > a)) { a = auto[0]; b = auto[1]; } return [a, b]; };
function xAuto() {
  const xs = S.spectra.filter(s => s.show && DATA[s.id]).map(s => proc(s).x), sp = cur();
  if (!xs.length && sp && DATA[sp.id]) xs.push(proc(sp).x);
  return xs.length ? extent(xs, 0) : [100, 1000];
}
const xRange = () => fill(LIMS.x, xAuto());
const redrawBoth = () => { drawWf(); drawFit(); };
function fmtL(v, span) { const d = span >= 50 ? 0 : span >= 5 ? 1 : span >= 0.5 ? 2 : 3; return String(+v.toFixed(d)); }
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
    box('x0', 'x', 0, ''); box('x1', 'x', 1, 'r'); box('y1', ykey, 1, 'r'); box('y0', ykey, 0, 'r');
    const btn = (k, lim) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'axauto'; b.textContent = 'auto';
      b.title = 'Autoscale ' + k.toUpperCase(); b.onclick = () => { LIMS[lim] = [null, null]; redrawBoth(); }; host.appendChild(b); ui[k] = b; };
    btn('ax', 'x'); btn('ay', ykey);
  }
  const put = (e, l, t) => { e.style.left = l + 'px'; e.style.top = t + 'px'; };
  put(ui.x0, F.L - 4, F.T + F.ph + 4); put(ui.x1, F.L + F.pw - 46, F.T + F.ph + 4);
  put(ui.y1, F.L - 56, F.T - 9); put(ui.y0, F.L - 56, F.T + F.ph - 10);
  put(ui.ay, F.L - 90, F.T - 7); put(ui.ax, F.L + F.pw - 34, F.T + F.ph + 27);
  const val = (e, v, span, set) => { if (document.activeElement !== e) e.value = e.dataset.v = fmtL(v, span); e.classList.toggle('set', set); };
  val(ui.x0, xr[0], xr[1] - xr[0], LIMS.x[0] != null); val(ui.x1, xr[1], xr[1] - xr[0], LIMS.x[1] != null);
  val(ui.y0, yr[0], yr[1] - yr[0], LIMS[ykey][0] != null); val(ui.y1, yr[1], yr[1] - yr[0], LIMS[ykey][1] != null);
  ui.ax.classList.toggle('set', LIMS.x.some(v => v != null)); ui.ay.classList.toggle('set', LIMS[ykey].some(v => v != null));
}

// ---------------- page layout ----------------
function build() {
  const tb = $('.toolbar[data-pane=raman]');
  tb.innerHTML = `
    <label class="rdrop" id="r_drop" title="Drop Raman .txt files here, or click to choose several">
      <input type="file" id="r_file" multiple accept=".txt,.csv,.dat,.json" hidden>
      <span class="ic">⇣</span><span><b>Drop Raman .txt files here</b><br><u>or click to choose files…</u></span></label>
    <span class="hbtns">
      <button type="button" id="r_undo" class="big" title="Undo (Ctrl+Z)">↶ Undo</button>
      <button type="button" id="r_redo" class="big" title="Redo (Ctrl+Y)">↷ Redo</button>
      <button type="button" id="r_hist" title="All steps">Steps <b id="r_hn">0</b> ▾</button>
    </span>
    <span class="sp"></span>
    <span id="r_save" class="gmuted"></span>
    <button type="button" id="r_export" class="primary" title="Write corrected spectra, fit curves and peak tables">Export results</button>`;
  const sec = $('section[data-pane=raman]');
  sec.innerHTML = `
    <div id="r_msg"></div>
    <div class="rgrid" id="r_grid">
      <div class="mod rwf">
        <div class="rsplit" id="r_split" title="Drag to make the plots narrower or wider · double-click: half and half"></div>
        <div class="bar"><span class="t">Spectra</span>
          <span class="opts">Show <select id="wf_view"><option value="corrected">corrected</option><option value="raw">raw + background</option></select>
          <label><input type="checkbox" id="wf_norm"> normalize</label> <label>offset <input type="number" id="wf_off" step="0.1" style="width:56px"></label></span>
          <button type="button" class="primary" id="ft_open">Open fitting ▸</button>
          <button type="button" class="expbtn" data-png="wf">Export PNG</button></div>
        <div class="hintrow" id="wf_hint"></div>
        <div class="plot"><canvas id="wf_cv"></canvas></div>
        <div id="wf_list"></div>
        <div class="pre" id="wf_pre"></div>
      </div>
      <div class="mod rfit" id="r_fit" hidden>
        <div class="bar"><span class="t" id="ft_title">Fitting</span>
          <span id="ft_btns" class="opts"></span>
          <button type="button" id="ft_close" title="Close the fitting panel">✕ Close</button>
          <button type="button" class="expbtn" data-png="fit">Export PNG</button></div>
        <div class="hintrow" id="ft_hint"></div>
        <div class="plot"><canvas id="ft_cv"></canvas></div>
        <div class="side" id="ft_side"></div>
      </div>
    </div>`;
  $('#ft_open').onclick = () => { FITOPEN = true; render(); };
  $('#ft_close').onclick = () => { FITOPEN = false; render(); };
  // file input / drop
  $('#r_file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#r_drop');
  for (const el of [dz, sec]) {
    el.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    el.addEventListener('dragleave', () => dz.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  }
  $('#r_undo').onclick = undo; $('#r_redo').onclick = redo;
  $('#r_hist').onclick = showHist;
  { // divider on the right edge of the spectra card: drag = share of the width (kept in this browser)
    const grid = $('#r_grid'), h = $('#r_split');
    const setF = f => { if (f == null) { grid.style.removeProperty('--rl'); grid.style.removeProperty('--rr'); } else { grid.style.setProperty('--rl', f + 'fr'); grid.style.setProperty('--rr', (1 - f) + 'fr'); } drawWf(); drawFit(); };
    try { const f = +localStorage.getItem('nqp_rsplit'); if (f >= 0.2 && f <= 0.85) setF(f); } catch {}
    let drag = false, raf = 0;
    h.addEventListener('pointerdown', e => { drag = true; h.classList.add('on'); h.setPointerCapture(e.pointerId); e.preventDefault(); });
    h.addEventListener('pointermove', e => { if (!drag) return; const r = grid.getBoundingClientRect(), f = Math.min(0.85, Math.max(0.2, (e.clientX - r.left - 16 - 6) / (r.width - 32 - 12)));
      cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setF(+f.toFixed(3))); h._f = f; });
    const end = () => { if (!drag) return; drag = false; h.classList.remove('on'); try { if (h._f) localStorage.setItem('nqp_rsplit', h._f.toFixed(3)); } catch {} };
    h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
    h.addEventListener('dblclick', () => { setF(null); h._f = 0; try { localStorage.removeItem('nqp_rsplit'); } catch {} });
  }
  $('#r_export').onclick = exportAll;
  $('#wf_view').onchange = e => { S.wf.view = e.target.value; commit('Waterfall: show ' + e.target.value); };
  $('#wf_norm').onchange = e => { S.wf.norm = e.target.checked; commit(e.target.checked ? 'Waterfall: normalize' : 'Waterfall: no normalize'); };
  $('#wf_off').onchange = e => { S.wf.offset = +e.target.value || 0; commit('Waterfall offset ' + S.wf.offset); };
  document.querySelectorAll('[data-png]').forEach(b => b.onclick = () => savePng(b.dataset.png));
  document.addEventListener('keydown', e => {
    if ($('section[data-pane=raman]').hidden || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
    else if (k === 'escape' && PICK) { PICK = false; render(); }
    else if ((k === 'delete' || k === 'backspace') && ACTIVE && mode() === 'fit') { delPeak(ACTIVE); }
  });
  wfEvents(); fitEvents();
  new ResizeObserver(() => { if (!sec.hidden) { drawWf(); drawFit(); } }).observe(sec);
}
const msg = t => { const m = $('#r_msg'); if (m) m.textContent = t; };

// ---------------- render ----------------
function render() {
  if (!$('#wf_cv')) return;
  $('#r_undo').disabled = HPOS <= 0; $('#r_redo').disabled = HPOS >= HIST.length - 1;
  $('#r_undo').title = HPOS > 0 ? 'Undo: ' + HIST[HPOS].label + ' (Ctrl+Z)' : 'Nothing to undo';
  $('#r_redo').title = HPOS < HIST.length - 1 ? 'Redo: ' + HIST[HPOS + 1].label + ' (Ctrl+Y)' : 'Nothing to redo';
  $('#r_hn').textContent = Math.max(0, HPOS);
  $('#r_fit').hidden = !FITOPEN; $('#ft_open').hidden = FITOPEN;
  $('#wf_hint').innerHTML = PICK ? `<b>Click one point on each curve</b> — it is moved to ${+S.shiftTarget} cm⁻¹ (snaps to the nearest maximum). Esc to finish.` : 'Click a curve to select it · double-click to reset the axes';
  $('#wf_hint').classList.toggle('hint', PICK);
  $('#wf_view').value = S.wf.view; $('#wf_norm').checked = S.wf.norm; $('#wf_off').value = S.wf.offset;
  renderList(); renderPre(); drawWf(); renderFitBar(); drawFit(); renderSide();
}
function renderList() {
  const box = $('#wf_list');
  if (!S.spectra.length) { box.innerHTML = '<div class="empty">No spectra yet — drop .txt files (two columns: Raman shift, intensity) on the box above.</div>'; return; }
  box.innerHTML = S.spectra.map(s => `<div class="srow${s.id === S.sel ? ' on' : ''}" data-id="${s.id}">
    <input type="checkbox" ${s.show ? 'checked' : ''} title="Show in waterfall"><input type="color" value="${s.color}">
    <span class="nm" title="Rest the pointer here, then click to edit the label · file: ${esc(s.file || s.name)}">${esc(s.name)}</span><span class="ed" title="Rename">✎</span>
    <span class="meta">${s.fit.peaks.length ? s.fit.peaks.length + ' peaks' : ''}${bgDone(s) ? ' · bg removed' : bgShown(s) ? ' · bg shown' : ''}${s.despike.on ? ' · despiked' : ''}</span>
    <span class="x" title="Remove">✕</span></div>`).join('');
  box.querySelectorAll('.srow').forEach(r => { const s = S.spectra.find(q => q.id === r.dataset.id);
    r.onclick = e => { if (e.target.tagName === 'INPUT' || e.target.classList.contains('x') || e.target.classList.contains('ed')) return; select(s.id); };
    const rename = () => { const nm = r.querySelector('.nm'); if (!nm) return;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = s.name; inp.className = 'nmedit'; nm.replaceWith(inp); inp.focus(); inp.select();
      let done = false; const fin = ok => { if (done) return; done = true; const v = inp.value.trim();
        if (ok && v && v !== s.name) { const old = s.name; s.file = s.file || old; s.name = v; commit(`Rename ${old} → ${v}`); } else renderList(); };
      inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
      inp.onblur = () => fin(true); };
    const nm = r.querySelector('.nm'); let armT = null;                  // a quick click selects the spectrum; resting on the name first makes the click edit it
    nm.onmouseenter = () => { armT = setTimeout(() => nm.classList.add('arm'), NAME_ARM_MS); };
    nm.onmouseleave = () => { clearTimeout(armT); nm.classList.remove('arm'); };
    nm.onclick = e => { if (nm.classList.contains('arm')) { e.stopPropagation(); clearTimeout(armT); rename(); } };
    nm.ondblclick = e => { e.stopPropagation(); rename(); };
    r.querySelector('.ed').onclick = e => { e.stopPropagation(); rename(); };
    r.querySelector('[type=checkbox]').onchange = e => { s.show = e.target.checked; commit((s.show ? 'Show ' : 'Hide ') + s.name); };
    r.querySelector('[type=color]').onchange = e => { s.color = e.target.value; commit('Colour ' + s.name); };
    r.querySelector('.x').onclick = () => { S.spectra = S.spectra.filter(q => q !== s); if (S.sel === s.id) S.sel = S.spectra[0] ? S.spectra[0].id : null; commit('Remove ' + s.name); };
  });
}
function select(id) { if (S.sel === id) return; S.sel = id; ACTIVE = null; commit('Select ' + (cur() || {}).name); }
const NAME_ARM_MS = 350;
const LAM_PRESET = {'1e5': 'λ 1e5', '1e6': 'λ 1e6', '1e7': 'λ 1e7'};
function renderPre() {                          // despike and background(+zero) act on all spectra; shift is set curve by curve
  const sp = cur(), box = $('#wf_pre');
  if (!sp) { box.innerHTML = ''; return; }
  const b = sp.bg, r = proc(sp), lamKey = Object.keys(LAM_PRESET).find(k => +k === +b.lam) || 'custom', bgOn = bgShown(sp), bgRem = bgDone(sp);
  const zOn = bgRem && zeroOn(sp), zAuto = (sp.zero.mode || 'manual') === 'auto', zr = r.zero;
  const zA = zAuto && zr ? +zr.a.toFixed(0) : sp.zero.a, zB = zAuto && zr ? +zr.b.toFixed(0) : sp.zero.b;
  const nsp = S.spectra.reduce((n, q) => n + (q.despike.on ? proc(q).spikes : 0), 0);
  box.innerHTML = `
    <div class="prow"><button type="button" id="ds_on" class="tg${sp.despike.on ? ' on' : ''}" title="Remove cosmic-ray spikes from all spectra">Despike</button>
      <label>2nd difference &gt; <input type="number" id="ds_thr" value="${sp.despike.thr}" min="3" step="1" style="width:60px"> × MAD</label>
      <span class="gmuted">${sp.despike.on ? nsp + ' spike' + (nsp === 1 ? '' : 's') + ' removed' : ''}</span></div>
    <div class="prow"><button type="button" id="bg_on" class="tg${bgOn ? ' on' : ''}" title="Step 1: show the arPLS baseline (dashed) on the original spectra and choose λ. Click again to switch the background off.">Background</button>
      ${bgOn ? `<select id="bg_pre" ${bgRem ? 'disabled' : ''}>${Object.entries(LAM_PRESET).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}<option value="custom">custom λ</option></select>
      <label>λ <input type="text" id="bg_l" value="${(+b.lam).toExponential(0).replace('+', '')}" style="width:60px" ${bgRem ? 'disabled' : ''}></label>
      <button type="button" id="bg_go" class="${bgRem ? '' : 'primary'}" title="${bgRem ? 'Back to step 1: original spectra with the dashed baseline, to change λ' : 'Step 2: subtract the dashed baseline from all spectra'}">${bgRem ? 'Show background again' : 'Remove background'}</button>` : '<span class="gmuted">shows the baseline first, then removes it</span>'}</div>
    <div class="prow"><button type="button" id="z_on" class="tg${zOn ? ' on' : ''}" ${bgRem ? '' : 'disabled'} title="Set the mean of a noise segment to 0 (after the background is removed)">Zero</button>
      ${!bgRem ? '<span class="gmuted">after the background is removed</span>' : `<select id="z_mode"><option value="auto">auto: lower of the two ends</option><option value="manual">manual window</option></select>
      <label>mean of <input type="number" id="z_a" value="${zA}" style="width:66px" ${zAuto ? 'disabled' : ''}> – <input type="number" id="z_b" value="${zB}" style="width:66px" ${zAuto ? 'disabled' : ''}> cm⁻¹ = 0</label>`}</div>
    <div class="prow"><button type="button" id="sh_pick" class="tg${PICK ? ' pick' : S.spectra.some(q => q.shiftOn && q.shift) ? ' on' : ''}" title="Click, then click one point on each curve in the plot">${PICK ? 'Shift: picking…' : 'Shift'}</button>
      <label>click a point on each curve → move it to <input type="number" id="sh_t" value="${+S.shiftTarget}" step="1" style="width:66px"> cm⁻¹</label>
      <span class="gmuted">${sp.shiftOn && sp.shift ? `<span style="color:${sp.color}">■</span> ${(sp.shift > 0 ? '+' : '') + (+(+sp.shift).toFixed(1))} cm⁻¹ <a href="#" id="sh_clr">reset</a>` : ''}</span></div>`;
  if (bgOn) $('#bg_pre').value = lamKey;
  const all = (fn, lab) => e => { for (const q of S.spectra) fn(q, e.target); PCACHE.clear(); for (const q of S.spectra) if (q.fit.peaks.length) runFit(q, {iters: 60}); commit(lab(e.target)); };
  const live = fn => e => { for (const q of S.spectra) fn(q, e.target); PCACHE.clear(); drawWf(); drawFit(); renderSide(); };
  const dsNew = !sp.despike.on;
  $('#ds_on').onclick = all(q => q.despike.on = dsNew, () => 'Despike ' + (dsNew ? 'on' : 'off'));
  $('#ds_thr').oninput = live((q, t) => q.despike.thr = +t.value);
  $('#ds_thr').onchange = all((q, t) => q.despike.thr = +t.value, t => `Despike ${t.value}×MAD`);
  $('#bg_on').onclick = all(q => { q.bg.method = bgOn ? 'none' : 'arpls'; q.bg.applied = false; }, () => 'Background ' + (bgOn ? 'off' : 'shown'));
  if (bgOn) {
    $('#bg_pre').onchange = all((q, t) => { if (t.value !== 'custom') q.bg.lam = +t.value; }, t => `arPLS λ ${t.value}`);
    $('#bg_l').onchange = all((q, t) => q.bg.lam = +t.value || 1e5, t => `arPLS λ ${t.value}`);
    $('#bg_go').onclick = all(q => { q.bg.applied = !bgRem; if (!bgRem) { q.zero.on = true; q.zero.mode = 'auto'; } }, () => bgRem ? 'Background shown again' : 'Background removed, zero auto');   // removing the background switches Zero on in auto mode
  }
  if (bgRem) {
    $('#z_on').onclick = all(q => { q.zero.on = !zOn; if (q.zero.mode === undefined) q.zero.mode = 'manual'; }, () => 'Zero ' + (zOn ? 'off' : 'on'));
    $('#z_mode').value = zAuto ? 'auto' : 'manual';
    $('#z_mode').onchange = all((q, t) => { if (t.value === 'manual' && (q.zero.mode || 'manual') === 'auto') { const z = proc(q).zero; if (z) { q.zero.a = +z.a.toFixed(0); q.zero.b = +z.b.toFixed(0); } }   // manual starts from the window auto chose
      q.zero.mode = t.value; q.zero.on = true; }, t => 'Zero ' + t.value);
    for (const k of ['a', 'b']) { $('#z_' + k).oninput = live((q, t) => q.zero[k] = +t.value); $('#z_' + k).onchange = all((q, t) => q.zero[k] = +t.value, () => `Zero window ${sp.zero.a}–${sp.zero.b}`); }
  }
  $('#sh_t').onchange = e => { S.shiftTarget = +e.target.value || 0; commit('Shift target ' + S.shiftTarget + ' cm⁻¹'); };
  $('#sh_pick').onclick = () => { PICK = !PICK; render(); };
  if ($('#sh_clr')) $('#sh_clr').onclick = e => { e.preventDefault(); sp.shift = 0; sp.shiftOn = false; PCACHE.clear(); runFit(sp, {iters: 60}); commit(`${sp.name}: shift reset`); };
}

// ---------------- waterfall ----------------
let WF = null, wfDrag = null;
function wfCurves() {
  const shown = S.spectra.filter(s => s.show && DATA[s.id]), N = shown.length, out = [];
  shown.forEach((s, k) => {
    const r = proc(s), raw = S.wf.view === 'raw' || (bgShown(s) && !bgDone(s)), y = raw ? r.ds : r.y;
    let sc = 1; if (S.wf.norm) { let mx = 0, mn = Infinity; for (const v of y) { if (v > mx) mx = v; if (v < mn) mn = v; } sc = 1 / ((mx - (raw ? mn : 0)) || 1); }
    const sub = raw && S.wf.norm ? Math.min(...y) : 0, off = (N - 1 - k) * S.wf.offset * (S.wf.norm ? 1 : 1);
    out.push({s, x: r.x, y: y.map(v => (v - sub) * sc + off), base: raw && s.bg.method !== 'none' ? r.base.map(v => (v - sub) * sc + off) : null, off});
  });
  return out;
}
function drawWf() {
  const cv = $('#wf_cv'); if (!cv || $('section[data-pane=raman]').hidden) return;
  const C = wfCurves(), all = C.map(c => c.x);
  const xr = xRange();
  const vis = C.map(c => c.y.filter((v, i) => c.x[i] >= xr[0] && c.x[i] <= xr[1]));
  const series = [];
  for (const c of C) { const on = c.s.id === S.sel && !EXPORTING;
    const lab = S.wf.lab, lx = lab ? xr[0] + lab.fx * (xr[1] - xr[0]) : null;       // every label sits at the same place relative to its own curve
    series.push({x: c.x, y: c.y, color: c.s.color, width: on ? 2.4 : 1.1, label: c.s.name, id: c.s.id, bold: on,
      labelX: lx, labelY: lab ? c.y[nearestIdx(c.x, lx)] : c.y[c.y.length - 1], labelDy: lab ? lab.dy : null});
    if (c.base) series.push({x: c.x, y: c.base, color: c.s.color, width: 1, dash: [5, 4]}); }
  const sel = C.find(c => c.s.id === S.sel), fr = sel && sel.s.fit.range;
  const yr = fill(LIMS.wf, C.length ? extent(vis, 0.06) : [0, 1]);
  WF = drawPlot(cv, 380, {xr, yr, series, xlabel: 'Raman shift (cm⁻¹)', ylabel: 'Intensity (a.u.)',
    bands: fr && FITOPEN && !EXPORTING ? [{a: fr[0], b: fr[1], color: 'rgba(255,200,60,.10)'}] : [], vlines: PICK && !EXPORTING ? [{x: +S.shiftTarget, color: '#d62728'}] : [],
    drag: null});
  axisUI(cv, WF, 'wf', xr, yr);
  WF.curves = C;
}
function wfEvents() {
  const cv = $('#wf_cv');
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
    if (PICK) {                                  // move the clicked point (nearest maximum within ±10 cm⁻¹) to the target
      let i = nearestIdx(best.x, x), j = i; for (let k = 0; k < best.x.length; k++) if (Math.abs(best.x[k] - x) <= 10 && best.y[k] > best.y[j]) j = k;
      const sp = best.s, was = sp.shiftOn ? +sp.shift || 0 : 0;
      sp.shift = +(was + S.shiftTarget - best.x[j]).toFixed(2); sp.shiftOn = true; S.sel = sp.id; PCACHE.clear(); runFit(sp, {iters: 60});
      return commit(`${sp.name}: shift ${sp.shift} (point ${best.x[j].toFixed(1)} → ${+S.shiftTarget})`);
    }
    select(best.s.id);
  });
  cv.addEventListener('dblclick', () => { if (PICK) return; LIMS.x = [null, null]; LIMS.wf = [null, null]; redrawBoth(); });
}
function nearestIdx(xs, x) { let lo = 0, hi = xs.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; xs[m] < x ? lo = m : hi = m; } return Math.abs(xs[lo] - x) < Math.abs(xs[hi] - x) ? lo : hi; }

// ---------------- fitting window ----------------
function renderFitBar() {
  const sp = cur(), b = $('#ft_btns'), h = $('#ft_hint');
  $('#ft_title').innerHTML = sp ? `Fitting · <span style="color:${sp.color}">${esc(sp.name)}</span>` : 'Fitting';
  if (!sp) { b.innerHTML = ''; h.innerHTML = 'Load spectra first.'; return; }
  const fr = sp.fit.range;
  b.innerHTML = `<label>range <input type="number" id="ft_a" value="${fr ? +fr[0].toFixed(1) : ''}" style="width:72px"> – <input type="number" id="ft_b" value="${fr ? +fr[1].toFixed(1) : ''}" style="width:72px"> cm⁻¹</label>
    <label>rule <select id="ft_rule">${Object.entries(RULES).map(([k, v]) => `<option value="${k}" ${sp.fit.rule === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
  h.classList.toggle('hint', mode() === 'range');
  h.innerHTML = mode() === 'range' ? '<b>Drag across the plot</b> to choose the fitting range (or type it above). It need not match the view.'
    : 'Double-click: add a peak · drag a dot: move it · scroll: width · drag a dashed line: change the range · the fit updates as you go';
  const rs = $('#ft_rule'); if (rs) rs.onchange = () => { applyRule(sp, rs.value); commit(`${sp.name}: rule ${rs.value}`); };
  for (const k of ['ft_a', 'ft_b']) { const el = $('#' + k); if (el) el.onchange = () => {
    const a = +$('#ft_a').value, c = +$('#ft_b').value; if (!isFinite(a) || !isFinite(c) || a === c) return;
    sp.fit.range = [Math.min(a, c), Math.max(a, c)]; runFit(sp, {iters: 150}); commit(`${sp.name}: range ${sp.fit.range.map(v => v.toFixed(0)).join('–')}`); }; }
}
let FT = null, ftDrag = null, liveT = null, wheelT = null;
function drawFit() {
  const cv = $('#ft_cv'), sp = cur(); if (!cv || !FITOPEN || $('section[data-pane=raman]').hidden) return;
  if (!sp || !DATA[sp.id]) { const xr = xRange(), yr = fill(LIMS.fit, [0, 1]); FT = drawPlot(cv, 380, {xr, yr, series: [], xlabel: 'Raman shift (cm⁻¹)', ylabel: 'Intensity (a.u.)'}); axisUI(cv, FT, 'fit', xr, yr); return; }
  const r = proc(sp), xr = xRange(), fr = sp.fit.range, P = sp.fit.peaks;
  const vi = [], vy = []; for (let i = 0; i < r.x.length; i++) if (r.x[i] >= xr[0] && r.x[i] <= xr[1]) { vi.push(r.x[i]); vy.push(r.y[i]); }
  const series = [], marks = [];
  if (fr && P.length) {
    const xs = []; const st = (fr[1] - fr[0]) / 600; for (let x = fr[0]; x <= fr[1] + st / 2; x += st) xs.push(x);
    P.forEach((p, k) => { const col = p.color || PEAK_COL[k % PEAK_COL.length], y = xs.map(x => pv(x, p));
      series.push({x: xs, y, color: col, width: 1, fill: hexA(col, p.id === ACTIVE && !EXPORTING ? .42 : .28)});
      marks.push({x: p.c, y: p.h, color: col, text: p.c.toFixed(0), on: p.id === ACTIVE && !EXPORTING}); });
  }
  series.push({x: vi, y: vy, color: '#8a9099', points: 2.6});
  if (fr && P.length) { const xs = series[0].x; series.push({x: xs, y: xs.map(x => P.reduce((s, p) => s + pv(x, p), 0)), color: '#111', width: 1.6}); }
  let yr = extent([vy, ...series.filter(s => s.fill).map(s => s.y)], 0.05); yr = fill(LIMS.fit, [Math.min(yr[0], 0 - (yr[1] - yr[0]) * .03), yr[1] + (yr[1] - yr[0]) * .06]);
  const bands = [];
  if (fr && !EXPORTING) bands.push({a: fr[0], b: fr[1], color: mode() === 'range' ? 'rgba(255,190,40,.18)' : 'rgba(255,200,60,.09)', edge: '#e0a800'});
  FT = drawPlot(cv, 380, {xr, yr, series, marks, bands, xlabel: 'Raman shift (cm⁻¹)', ylabel: 'Intensity (a.u.)',
    drag: ftDrag && ftDrag.kind !== 'peak' && ftDrag.moved ? {a: ftDrag.a, b: ftDrag.b, color: ftDrag.kind === 'range' ? 'rgba(255,190,40,.3)' : 'rgba(31,95,191,.12)'} : null});
  axisUI(cv, FT, 'fit', xr, yr);
  cv.style.cursor = mode() === 'range' ? 'col-resize' : mode() === 'fit' ? 'crosshair' : 'default';
}
const hexA = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
function hitPeak(e) {
  const sp = cur(); if (!sp || !FT || mode() !== 'fit') return null; let best = null, bd = 14;
  for (const p of sp.fit.peaks) { const d = Math.hypot(FT.px(p.c) - e.offsetX, FT.py(p.h) - e.offsetY); if (d < bd) { bd = d; best = p; } }
  return best;
}
function liveFit(fix) {                        // throttled quick refit of the other peaks while dragging / scrolling
  if (liveT) return; liveT = requestAnimationFrame(() => { liveT = null; const sp = cur(); runFit(sp, {iters: 12, fix}); drawFit(); renderSide(); });
}
function fitEvents() {
  const cv = $('#ft_cv');
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
    if (ftDrag.kind === 'peak') { const p = ftDrag.p; p.c = FT.ix(e.offsetX); p.h = Math.max(0, FT.iy(e.offsetY)); cv.style.cursor = 'grabbing'; liveFit(p.id); return; }
    if (ftDrag.kind === 'edge') { const v = FT.ix(e.offsetX), o = fr0[1 - ftDrag.i]; fr0[ftDrag.i] = ftDrag.i ? Math.max(v, o + 10) : Math.min(v, o - 10);
      $('#ft_a').value = fr0[0].toFixed(1); $('#ft_b').value = fr0[1].toFixed(1); liveFit(null); return; }
    ftDrag.b = FT.ix(e.offsetX); if (Math.abs(e.offsetX - ftDrag.X) > 4) ftDrag.moved = true; drawFit();
  });
  cv.addEventListener('pointerup', () => {
    const d = ftDrag, sp = cur(); ftDrag = null; if (!d || !sp) return;
    if (d.kind === 'peak') { runFit(sp, {iters: 30, fix: d.p.id}); commit(`${sp.name}: move ${d.p.name} to ${d.p.c.toFixed(1)}`); return; }
    if (d.kind === 'edge') { runFit(sp, {iters: 150}); return commit(`${sp.name}: fitting range ${sp.fit.range.map(v => v.toFixed(0)).join('–')} cm⁻¹`); }
    if (!d.moved) { drawFit(); return; }
    const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
    if (d.kind === 'range') { sp.fit.range = [a, b]; runFit(sp, {iters: 150}); commit(`${sp.name}: fitting range ${a.toFixed(0)}–${b.toFixed(0)} cm⁻¹`); }
  });
  cv.addEventListener('dblclick', e => {
    const sp = cur(); if (!sp) return;
    if (mode() !== 'fit' || !sp.fit.range) { LIMS.x = [null, null]; LIMS.fit = [null, null]; redrawBoth(); return; }
    const x = FT.ix(e.offsetX), r = proc(sp), i = nearestIdx(r.x, x);
    const rest = r.y[i] - sp.fit.peaks.reduce((s, p) => s + pv(x, p), 0);
    const used = new Set(sp.fit.peaks.map(p => p.color)), col = PEAK_COL.find(c => !used.has(c)) || PEAK_COL[sp.fit.peaks.length % PEAK_COL.length];
    const p = {id: nid(), name: 'P' + (sp.fit.peaks.length + 1), c: x, w: 30, h: Math.max(rest, (r.y[i] || 0) * 0.3, 1e-6), eta: 0, etaFree: false, lock: false, color: col};
    sp.fit.peaks.push(p); ACTIVE = p.id;
    runFit(sp, {iters: 150});
    commit(`${sp.name}: add peak at ${x.toFixed(0)}`);
  });
  cv.addEventListener('wheel', e => {
    const sp = cur(); if (!sp || mode() !== 'fit' || !sp.fit.peaks.length || !FT) return;
    e.preventDefault();
    const x = FT.ix(e.offsetX); let p = sp.fit.peaks.reduce((a, b) => Math.abs(b.c - x) < Math.abs(a.c - x) ? b : a);
    ACTIVE = p.id; p.w = Math.max(1, p.w * (e.deltaY < 0 ? 1.06 : 1 / 1.06));
    liveFit(p.id);
    clearTimeout(wheelT); wheelT = setTimeout(() => commit(`${sp.name}: ${p.name} width ${p.w.toFixed(1)}`), 500);
  }, {passive: false});
}
function delPeak(id) { const sp = cur(); if (!sp) return; const p = sp.fit.peaks.find(q => q.id === id); if (!p) return;
  sp.fit.peaks = sp.fit.peaks.filter(q => q !== p); for (const r of sp.fit.ratios) { r.num = r.num.filter(i => i !== id); r.den = r.den.filter(i => i !== id); }
  ACTIVE = null; runFit(sp, {iters: 150}); commit(`${sp.name}: delete ${p.name}`); }

// ---------------- side panel: peaks, R², ratios ----------------
const f1 = (v, d = 1) => isFinite(v) ? (+v).toFixed(d) : '';
const limTxt = (p, k) => { const l = lim(p, k); return !l ? 'free' : l[0] === l[1] ? 'fixed at ' + l[0] : `limits ${l[0]}–${l[1]}`; };
function renderSide() {
  const sp = cur(), box = $('#ft_side'); if (!box) return;
  if (!sp) { box.innerHTML = ''; return; }
  const P = sp.fit.peaks, st = fitStats(sp), tot = P.reduce((s, p) => s + area(p), 0);
  const focus = document.activeElement && box.contains(document.activeElement) ? document.activeElement.dataset.f : null;
  box.innerHTML = `
    <div class="r2">R² = <b>${st ? st.r2.toFixed(4) : '—'}</b>${sp.fit.weight ? ` <span class="gmuted">· residuals weighted ×${sp.fit.weight.w} in ${sp.fit.weight.a}–${sp.fit.weight.b} cm⁻¹</span>` : ''}</div>
    <table class="pk"><thead><tr><th></th><th>Peak</th><th title="Peak position">Center</th><th title="Full width at half maximum">FWHM</th>
      <th title="Lorentzian fraction: 0 = pure Gaussian, 100 = pure Lorentzian; tick = let the fit change it">L % · fit</th><th>Height</th><th>Area</th><th>%</th><th title="Lock position and width">🔒</th><th></th></tr></thead>
    <tbody>${P.map((p, k) => `<tr data-id="${p.id}" class="${p.id === ACTIVE ? 'on' : ''}">
      <td><span class="sw" style="background:${p.color}"></span></td>
      <td><input data-f="name" value="${esc(p.name)}" class="nm"></td>
      <td><input data-f="c" type="number" step="0.5" value="${f1(p.c)}" title="${limTxt(p, 'c')}" class="${lim(p, 'c') ? 'lk' : ''}"></td>
      <td><input data-f="w" type="number" step="0.5" value="${f1(p.w)}" title="${limTxt(p, 'w')}" class="${lim(p, 'w') ? 'lk' : ''}"></td>
      <td><input data-f="eta" type="number" step="5" min="0" max="100" value="${f1(p.eta * 100, 0)}" title="${p.etaFree ? 'fitted' : 'fixed'}${lim(p, 'eta') ? ' · ' + limTxt(p, 'eta') : ''}"><label class="ef" title="Let the fit change L %"><input type="checkbox" data-f="etaFree" ${p.etaFree ? 'checked' : ''}></label></td>
      <td class="ro">${tfmt(+p.h.toPrecision(4))}</td><td class="ro">${tfmt(+area(p).toPrecision(4))}</td><td class="ro">${tot ? (100 * area(p) / tot).toFixed(1) : ''}</td>
      <td><input type="checkbox" data-f="lock" ${p.lock ? 'checked' : ''}></td><td><span class="x" title="Delete peak">✕</span></td></tr>`).join('')}</tbody></table>
    ${P.length ? '' : `<div class="gmuted" style="padding:6px 2px">${mode() === 'fit' ? 'Double-click on the plot to add the first peak, or choose a rule.' : 'Choose the fitting range first.'}</div>`}
    <div class="ratios"><div class="rh">Area ratios <button type="button" id="rt_add" ${P.length ? '' : 'disabled'}>+ ratio</button></div>
      ${sp.fit.ratios.map((r, i) => ratioHtml(sp, r, i)).join('')}</div>`;
  box.querySelectorAll('tr[data-id]').forEach(tr => {
    const p = P.find(q => q.id === tr.dataset.id);
    tr.onclick = () => { if (ACTIVE !== p.id) { ACTIVE = p.id; drawFit(); box.querySelectorAll('tr').forEach(t => t.classList.toggle('on', t === tr)); } };
    tr.querySelectorAll('[data-f]').forEach(inp => {
      const f = inp.dataset.f;
      const apply = () => { if (f === 'name') p.name = inp.value.trim() || p.name; else if (f === 'etaFree' || f === 'lock') p[f] = inp.checked;
        else { const v = +inp.value; if (!isFinite(v)) return; if (f === 'eta') p.eta = Math.min(1, Math.max(0, v / 100)); else if (f === 'w') p.w = Math.max(0.5, v); else p[f] = v; } };
      const hold = () => { if (f === 'c' || f === 'w' || f === 'eta') { const l = p.lock, e = p.etaFree; p.lock = true; p.etaFree = false; runFit(sp, {iters: 40}); p.lock = l; p.etaFree = e; } else if (f !== 'name') runFit(sp, {iters: 150}); };
      if (inp.type === 'number') inp.oninput = () => { apply(); hold(); drawFit(); };   // live: the typed value is kept, the rest refits
      inp.onchange = () => { apply(); hold(); commit(`${sp.name}: ${p.name} ${f} ${inp.type === 'checkbox' ? inp.checked : inp.value}`); };
    });
    tr.querySelector('.x').onclick = e => { e.stopPropagation(); delPeak(p.id); };
  });
  const add = $('#rt_add'); if (add) add.onclick = () => { sp.fit.ratios.push({num: P[0] ? [P[0].id] : [], den: P.map(p => p.id)}); commit(`${sp.name}: add ratio`); };
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
  let d = $('#r_hdlg');
  if (!d) { d = document.createElement('dialog'); d.id = 'r_hdlg'; d.className = 'small'; document.body.appendChild(d); }
  d.innerHTML = `<div class="eh"><span>Steps (click one to go back to it)</span><button type="button" id="rh_x">✕</button></div>
    <div class="sb" style="max-height:60vh;overflow:auto">${HIST.map((h, i) => `<div class="hrow${i === HPOS ? ' on' : ''}${i > HPOS ? ' fut' : ''}" data-i="${i}">
      <span class="gmuted">${i}</span> ${esc(h.label)} <span class="gmuted" style="margin-left:auto">${h.t.slice(11, 19)}</span></div>`).reverse().join('')}</div>`;
  d.querySelectorAll('.hrow').forEach(r => r.onclick = () => { jump(+r.dataset.i); showHist(); });
  $('#rh_x', d).onclick = () => d.close(); if (!d.open) d.showModal();
}

// ---------------- saving ----------------
let saveT = null, DIR = null, lastSaved = '';
function project() { return {app: 'CellPeek Raman', version: (window.NQP_CONFIG || {}).APP_VERSION, saved: new Date().toISOString(), state: S,
  steps: HIST.map(h => ({t: h.t, label: h.label})), data: Object.fromEntries(S.spectra.map(s => [s.id, DATA[s.id]]))}; }
function autosave() {
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    try { await idb().set('raman', {S, DATA: Object.fromEntries(Object.entries(DATA).filter(([k]) => HIST.some(h => h.s.includes(k)))), HIST, HPOS}); } catch {}
    if (DIR) try {
      const fh = await DIR.getFileHandle('CellPeek_Raman_project.json', {create: true}), w = await fh.createWritable();
      await w.write(JSON.stringify(project())); await w.close(); lastSaved = new Date().toTimeString().slice(0, 8);
    } catch (e) { lastSaved = 'error: ' + e.message; }
    else lastSaved = new Date().toTimeString().slice(0, 8);
    saveLabel();
  }, 800);
}
function saveLabel() {
  const el = $('#r_save'); if (!el) return;
  el.innerHTML = (DIR ? `Auto-saved ${esc(lastSaved)} → <b>${esc(DIR.name)}</b> <a href="#" id="r_dir">change</a>`
    : `Auto-saved in this browser ${esc(lastSaved)} · <a href="#" id="r_dir" class="srcneed" title="Choose a folder, e.g. in Google Drive, for the project file and exports">save to folder…</a>`);
  $('#r_dir').onclick = async e => { e.preventDefault();
    try { DIR = await window.showDirectoryPicker({id: 'cellpeek-raman', mode: 'readwrite'}); await idb().set('raman_dir', DIR); autosave(); } catch {} };
}
function loadProject(p) {
  if (!p || !p.state || !p.data) throw new Error('not a CellPeek Raman project');
  DATA = {...DATA, ...p.data}; S = p.state; PCACHE.clear();
  HIST = []; HPOS = -1; commit('Open project (' + (p.saved || '').slice(0, 16).replace('T', ' ') + ')');
}
async function restore() {
  try { const r = await idb().get('raman'); if (r && r.S) { DATA = r.DATA || {}; S = r.S; HIST = r.HIST || []; HPOS = r.HPOS ?? HIST.length - 1; } } catch {}
  if (!HIST.length) { HIST = [{s: JSON.stringify(S), label: 'Start', t: new Date().toISOString()}]; HPOS = 0; }
  try { const h = await idb().get('raman_dir'); if (h && (await h.queryPermission({mode: 'readwrite'})) === 'granted') DIR = h; } catch {}
  saveLabel();
}

// ---------------- export ----------------
const num = v => String(+(+v).toPrecision(7));
function exportFiles() {
  const files = [], sum = [['spectrum', 'peak', 'center', 'fwhm', 'L_percent', 'height', 'area', 'area_percent', 'R2', 'range_from', 'range_to'].join('\t')];
  for (const sp of S.spectra) {
    const r = proc(sp); if (!r) continue; const base = sp.name.replace(/[\\/:*?"<>|]/g, '_');
    files.push([base + '_corrected.txt', 'Raman shift (cm-1)\tintensity (corrected)\n' + r.x.map((x, i) => num(x) + '\t' + num(r.y[i])).join('\n') + '\n']);
    if (bgShown(sp) || sp.despike.on)
      files.push([base + '_background.txt', 'Raman shift (cm-1)\traw\tdespiked\tbackground\tcorrected\n' + r.x.map((x, i) => [x, r.raw[i], r.ds[i], r.base[i], r.y[i]].map(num).join('\t')).join('\n') + '\n']);
    if (sp.fit.range && sp.fit.peaks.length) {
      const P = sp.fit.peaks, {x, y} = inRange(sp), st = fitStats(sp), tot = P.reduce((s, p) => s + area(p), 0);
      files.push([base + '_fit.txt', ['Raman shift\tcorrected\tfit\t' + P.map(p => p.name).join('\t'),
        ...x.map((xx, i) => { const c = P.map(p => pv(xx, p)); return [xx, y[i], c.reduce((a, b) => a + b, 0), ...c].map(num).join('\t'); })].join('\n') + '\n']);
      const lines = ['peak\tcenter\tfwhm\tL_percent\theight\tarea\tarea_percent'];
      for (const p of P) { const row = [p.name, num(p.c), num(p.w), num(p.eta * 100), num(p.h), num(area(p)), num(100 * area(p) / tot)];
        lines.push(row.join('\t')); sum.push([sp.name, ...row, num(st.r2), num(sp.fit.range[0]), num(sp.fit.range[1])].join('\t')); }
      lines.push('', 'R2\t' + num(st.r2), 'range\t' + num(sp.fit.range[0]) + '\t' + num(sp.fit.range[1]));
      for (const q of sp.fit.ratios) lines.push(ratioName(sp, q) + '\t' + num(ratioVal(sp, q)));
      lines.push('', 'rule\t' + sp.fit.rule, 'weight\t' + (sp.fit.weight ? `x${sp.fit.weight.w} in ${sp.fit.weight.a}-${sp.fit.weight.b}` : 'none'),
        'despike\t' + (sp.despike.on ? sp.despike.thr + ' x MAD (2nd difference)' : 'off'), 'background\t' + (bgDone(sp) ? 'arPLS lambda ' + sp.bg.lam : bgShown(sp) ? 'arPLS lambda ' + sp.bg.lam + ' (shown only, not subtracted)' : 'none'),
        'zero\t' + (r.zero ? `mean ${+r.zero.a.toFixed(1)}-${+r.zero.b.toFixed(1)} (${sp.zero.mode === 'auto' ? 'auto, ' + r.zero.edge + ' end' : 'manual'})` : 'off'), 'shift\t' + (sp.shiftOn ? sp.shift : 'off'));
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
  if (window.NQP && NQP.log) NQP.log('raman_export', {n: files.length});
}
function savePng(which) {
  const cv = $(which === 'wf' ? '#wf_cv' : '#ft_cv'), sp = cur(), redraw = which === 'wf' ? drawWf : drawFit;
  EXPORTING = true; try { redraw(); } finally { EXPORTING = false; }      // the PNG is the plot as it is on screen: same range, same proportions, same labels and label positions
  const F = which === 'wf' ? WF : FT, cut = F ? Math.max(0, Math.round((F.L - 36) * (cv.width / (parseFloat(cv.style.width) || cv.width)))) : 0;   // empty left margin (room for the axis-end boxes on screen)
  const c2 = document.createElement('canvas'); c2.width = cv.width - cut; c2.height = cv.height; const g = c2.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c2.width, c2.height); g.drawImage(cv, -cut, 0);
  const a = document.createElement('a'); a.href = c2.toDataURL('image/png'); a.download = (which === 'wf' ? 'raman_waterfall' : 'raman_fit_' + (sp ? sp.name : '')) + '.png'; a.click();
  redraw();
}

// ---------------- start ----------------
window.addEventListener('DOMContentLoaded', async () => {
  build(); await restore(); render();
  window.addEventListener('cellpeek:tab', () => render());
});
NQP.raman = {wf: () => WF, addText: (name, text) => addFiles([new File([text], name)]), state: () => S, fitNow: () => { runFit(cur(), {iters: 300}); commit('fit'); }};
})();
