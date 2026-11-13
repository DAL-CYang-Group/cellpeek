// CellPeek — EIS DRT tab: distribution of relaxation times of a series of impedance spectra.
//
// The DRT is computed with the DRTtools method of the Ciucci group (MIT licence; https://github.com/ciuccislab/pyDRTtools):
//   Z(f) = R_inf + j·2πf·L + ∫ γ(ln τ) / (1 + j·2πf·τ) d ln τ
//   γ(ln τ) = Σ x_m · exp(−(ε (ln τ − ln τ_m))²)        Gaussian radial basis functions centred at τ_m = 1/f_m
//   minimise ‖A′x − Z′‖² + ‖A″x − Z″‖² + λ·xᵀMx,  x ≥ 0  (M: first-derivative penalty; real and imaginary parts together)
// The formulas for ε, A′, A″ and M follow pyDRTtools basics.py / runs.py (simple_run, Gaussian, FWHM coefficient 0.5, 1st order).
// Anyone who uses these results must cite:
//   T.H. Wan, M. Saccoccio, C. Chen, F. Ciucci, Electrochim. Acta 184 (2015) 483–499, doi:10.1016/j.electacta.2015.09.097
//
// On top of the DRT: γ is cut into peaks at its minima; R_contact = area of the first peak(s), R_ct = area of the peaks in the
// chosen range, diffusion peak(s) on the right are left out. One rule (peaks skipped on the left / on the right) for the whole set.
'use strict';
(function () {
const TWO_PI = 2 * Math.PI;
const CITE = 'T.H. Wan, M. Saccoccio, C. Chen, F. Ciucci, Electrochim. Acta 184 (2015) 483–499, doi:10.1016/j.electacta.2015.09.097';

// ---------------- DRT (DRTtools method) ----------------
// d = {f[], zr[], zi[]} sorted from high to low frequency.  Returns {lt[] (ln τ, fine grid), g[] (γ, Ω), R_inf, L, err (%)}
function drt(d, lam, coeff = 0.5) {
  const N = d.f.length, lt = d.f.map(f => -Math.log(f));                         // ln τ_m, τ_m = 1/f_m (ascending)
  let delta = 0; for (let i = 1; i < N; i++) delta += lt[i] - lt[i - 1]; delta /= (N - 1);
  const eps = coeff * 2 * Math.sqrt(Math.LN2) / delta;                           // FWHM of a basis function = delta / coeff
  // A′[n][m] = ∫ rbf(x) / (1 + α² e^{2x}) dx,  A″[n][m] = −∫ rbf(x) α / (e^{−x} + α² e^{x}) dx,  α = 2π f_n τ_m   (Simpson)
  const K = 160, X = 5 / eps, h = 2 * X / K, xs = [], ws = [];
  for (let k = 0; k <= K; k++) { const x = -X + k * h; xs.push(x); ws.push((k === 0 || k === K ? 1 : k % 2 ? 4 : 2) * h / 3 * Math.exp(-eps * eps * x * x)); }
  const ex = xs.map(Math.exp), P = N + 2;                                        // unknowns: [L, R_inf, x_1 … x_N]
  const Are = [], Aim = [];
  for (let n = 0; n < N; n++) { const re = new Float64Array(P), im = new Float64Array(P), w = TWO_PI * d.f[n];
    im[0] = w; re[1] = 1;
    for (let m = 0; m < N; m++) { const al = w * Math.exp(lt[m]); let a = 0, b = 0;
      for (let k = 0; k <= K; k++) { const t = al * ex[k], q = 1 / (1 + t * t); a += ws[k] * q; b += ws[k] * t * q; }
      re[m + 2] = a; im[m + 2] = -b; }
    Are.push(re); Aim.push(im); }
  // H = A′ᵀA′ + A″ᵀA″ + λM,  b = A′ᵀZ′ + A″ᵀZ″;  M[n][m] = ε (1 − a²) e^{−a²/2} √(π/2),  a = ε (ln τ_n − ln τ_m); L and R_inf are not penalised
  const H = [], b = new Float64Array(P);
  for (let i = 0; i < P; i++) { const row = new Float64Array(P);
    for (let j = 0; j <= i; j++) { let s = 0; for (let n = 0; n < N; n++) s += Are[n][i] * Are[n][j] + Aim[n][i] * Aim[n][j];
      if (i >= 2 && j >= 2) { const a = eps * (lt[i - 2] - lt[j - 2]); s += lam * eps * (1 - a * a) * Math.exp(-a * a / 2) * Math.sqrt(Math.PI / 2); }
      row[j] = s; }
    H.push(row); let t = 0; for (let n = 0; n < N; n++) t += Are[n][i] * d.zr[n] + Aim[n][i] * d.zi[n]; b[i] = t; }
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) H[i][j] = H[j][i];
  // quadratic programme with x ≥ 0: projected Gauss–Seidel (H is symmetric positive definite, so this converges to the constrained minimum)
  const x = new Float64Array(P); x[1] = Math.max(0, Math.min(...d.zr));
  for (let it = 0; it < 60000; it++) { let ch = 0, mx = 0;
    for (let i = 0; i < P; i++) { const Hi = H[i]; let s = b[i]; for (let j = 0; j < P; j++) s -= Hi[j] * x[j]; const v = Math.max(0, x[i] + s / Hi[i]); const dlt = Math.abs(v - x[i]); if (i >= 1) { if (dlt > ch) ch = dlt; if (v > mx) mx = v; } x[i] = v; }
    if (ch < 1e-10 * (mx || 1)) break; }
  // γ on a fine grid: 10 points per measured frequency, half a decade beyond the data on each side
  const M = 10 * N, a0 = lt[0] - 0.5 * Math.LN10, a1 = lt[N - 1] + 0.5 * Math.LN10, ltf = new Float64Array(M), g = new Float64Array(M);
  for (let p = 0; p < M; p++) { const y = a0 + (a1 - a0) * p / (M - 1); ltf[p] = y; let s = 0; for (let m = 0; m < N; m++) { const u = eps * (y - lt[m]); if (u > -6 && u < 6) s += x[m + 2] * Math.exp(-u * u); } g[p] = s; }
  let ss = 0; for (let n = 0; n < N; n++) { let re = 0, im = 0; for (let j = 0; j < P; j++) { re += Are[n][j] * x[j]; im += Aim[n][j] * x[j]; } ss += ((re - d.zr[n]) ** 2 + (im - d.zi[n]) ** 2) / (d.zr[n] ** 2 + d.zi[n] ** 2 || 1); }
  return {lt: ltf, g, R_inf: x[1], L: x[0], err: 100 * Math.sqrt(ss / N)};
}

// ---------------- peaks: γ is cut at its minima ----------------
// Returns {v: [indices of the cuts, first = 0, last = n−1], seg: [{a, b, area, imax}]};  area = ∫ γ d ln τ = resistance of that peak (Ω)
function peaks(lt, g, minProm = 0.02) {
  const n = g.length; let gmax = 0; for (const y of g) if (y > gmax) gmax = y;
  let v = [0];
  for (let i = 1; i < n - 1; i++) { let j = i; while (j + 1 < n && g[j + 1] === g[i]) j++;                 // a flat bottom counts as one minimum, at its middle
    if (g[i - 1] > g[i] && j + 1 < n && g[j + 1] > g[i]) v.push((i + j) >> 1); i = j; }
  v.push(n - 1);
  const segOf = () => v.slice(0, -1).map((a, k) => { const b = v[k + 1]; let im = a, area = 0; for (let i = a; i <= b; i++) { if (g[i] > g[im]) im = i; if (i > a) area += (g[i] + g[i - 1]) / 2 * (lt[i] - lt[i - 1]); }
    const lv = k === 0 && im === a ? -Infinity : g[a], rv = k === v.length - 2 && im === b ? -Infinity : g[b], base = Math.max(lv, rv);
    return {a, b, imax: im, area, prom: base === -Infinity ? g[im] : g[im] - base}; });
  let seg = segOf();
  while (seg.length > 1) {                        // ripples are not peaks: the least prominent one is merged with its neighbour
    let k = 0; for (let i = 1; i < seg.length; i++) if (seg[i].prom < seg[k].prom) k = i;
    if (seg[k].prom >= minProm * gmax) break;
    const li = k > 0 ? k : -1, ri = k < seg.length - 1 ? k + 1 : -1;            // interior cuts on the left / right of this segment (positions in v)
    const drop = li < 0 ? ri : ri < 0 ? li : (g[v[li]] >= g[v[ri]] ? li : ri);
    v.splice(drop, 1); seg = segOf();
  }
  return {v, seg, gmax};
}
// rule {nL, nR}: peaks skipped on the left (contact) and on the right (diffusion)
function applyCuts(pk, kS, kE) {                 // limits at the cuts v[kS] and v[kE]
  const K = pk.seg.length; kS = Math.min(Math.max(0, kS), K - 1); kE = Math.min(Math.max(kS + 1, kE), K);
  const sum = (a, b) => pk.seg.slice(a, b).reduce((s, q) => s + q.area, 0);
  return {kS, kE, nL: kS, nR: K - kE, iStart: pk.v[kS], iEnd: pk.v[kE], R_contact: sum(0, kS), R_ct: sum(kS, kE), R_diff: sum(kE, K)};
}
function applyRule(pk, rule) { const K = pk.seg.length, r = applyCuts(pk, rule.nL, K - rule.nR); r.clipped = r.nL !== rule.nL || r.nR !== rule.nR; return r; }

const API = {drt, peaks, applyRule, applyCuts, CITE};
if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
if (typeof document === 'undefined') return;

// =====================================================================================================================
// page
// =====================================================================================================================
const NQP = window.NQP = window.NQP || {};
const $ = (s, el) => (el || document).querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]));
const fmt = v => v == null || !isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3);
const natural = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const RANGE_TOL = 0.5;                            // decades: a start / end further than this from the median of the set is flagged
const ECM_POOR = 2.5;                             // % — as in the EIS ECM tab: 2 semicircles unless some spectra fit poorly, then 3 for all
// S.rule: one rule for the whole set. S.touched: the user has set it (until then: 1 contact peak, diffusion peak left out when the spectra have a tail)
const S = {spectra: [], lam: 1e-3, xlog: true, rule: {nL: 1, nR: 1}, touched: null, ecmMode: 3};
let seq = 0, busy = false;
const msg = t => { const e = $('#d_msg'); if (e) e.textContent = t || ''; };
const eis = () => NQP.eis;

function addSpectra(list) {
  for (const d of list) S.spectra.push({id: 'd' + (++seq), name: d.name, f: d.f, zr: d.zr, zi: d.zi, drt: null, pk: null, ecm: null});
  S.spectra.sort((a, b) => natural.compare(a.name, b.name));
  render(); compute(S.spectra.filter(s => !s.drt));
}
async function addFiles(files) {
  const out = [], bad = [];
  for (const f of files) { try { out.push(...eis().parseEIS(await f.text(), f.name)); } catch (e) { bad.push(`${f.name}: ${e.message}`); } }
  msg((out.length ? `${out.length} spectr${out.length === 1 ? 'um' : 'a'} loaded` : '') + (bad.length ? ` · Not read: ${bad.join('; ')}` : ''));
  if (out.length && NQP.log) NQP.log('drt_load', {n: out.length});
  addSpectra(out);
}
function compute(list) {                          // DRT of each spectrum, then the ECM value for comparison
  if (busy) { compute.more = (compute.more || []).concat(list); return; }
  busy = true; let i = 0; const lam = S.lam;
  const step = () => {
    if (lam !== S.lam) { busy = false; return compute(S.spectra.filter(s => !s.drt)); }
    if (i >= list.length) { busy = false; if (!S.touched) defaultRule(); render(); const m = compute.more; compute.more = null; if (m && m.length) return compute(m.filter(s => !s.drt)); return ecmQueue(); }
    const s = list[i++]; msg(`DRT ${i} / ${list.length} …`);
    try { s.drt = drt(s, lam); s.pk = peaks(s.drt.lt, s.drt.g); } catch (e) { s.drt = {failed: true, note: e.message}; s.pk = null; }
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}
function defaultRule() {                          // before the user chooses: first peak = contact; on the right, the peaks that lie in the diffusion tail
  const ok = S.spectra.filter(s => s.pk); if (!ok.length) return;
  const cnt = ok.map(s => { const sh = eis().shape(s); if (!sh.tail) return 0; const tauT = 1 / (TWO_PI * s.f[sh.iMin]) * 0.7;      // tail starts at the −Z″ minimum
    return Math.min(s.pk.seg.length - 2, s.pk.seg.filter(q => Math.exp(s.drt.lt[q.imax]) > tauT).length); }).sort((x, y) => x - y);
  S.rule = {nL: 1, nR: Math.max(0, cnt[cnt.length >> 1])};
}
let ecmBusy = false;
function ecmQueue() {                             // same principle as the ECM tab: one model for the set, 2 semicircles unless some fit poorly
  if (ecmBusy) return; const todo = S.spectra.filter(s => !s.ecm || s.ecm.mode !== S.ecmMode); if (!todo.length) { msg(''); return finishEcm(); }
  ecmBusy = true; let i = 0;
  const step = () => { if (i >= todo.length) { ecmBusy = false; return finishEcm(); }
    const s = todo[i++]; msg(`ECM comparison ${i} / ${todo.length} …`);
    try { const f = eis().fitSpectrum(s, {n: S.ecmMode, tail: 'auto'}); s.ecm = f ? {v: f.v, mode: S.ecmMode, R_ct: f.R_ct, R_contact: f.R_contact, err: f.err} : {v: eis().FITV, mode: S.ecmMode, failed: true}; } catch { s.ecm = {v: eis().FITV, mode: S.ecmMode, failed: true}; }
    renderTable(); setTimeout(step, 0); };
  setTimeout(step, 0);
}
function finishEcm() {
  if (S.ecmMode === 2 && S.spectra.some(s => s.ecm && (s.ecm.failed || s.ecm.err > ECM_POOR))) { S.ecmMode = 3; return ecmQueue(); }
  msg(''); renderTable();
}

// ---------------- results of the rule for every spectrum, and the check of the range ----------------
// The rule counts peaks, but peaks split and merge as a cell ages. So each start / end is compared with the median of the set (in decades of τ):
// further away than RANGE_TOL -> the minimum nearest to the median is used instead ('adjusted'); if even that is too far, the spectrum is flagged ('check').
function results() {
  const R = new Map(), st = [], en = [], dec = (s, i) => s.drt.lt[i] / Math.LN10;
  for (const s of S.spectra) { if (!s.pk) continue; const r = applyRule(s.pk, S.rule); R.set(s.id, r); st.push(dec(s, r.iStart)); en.push(dec(s, r.iEnd)); }
  const med = a => { const b = a.slice().sort((x, y) => x - y), m = b.length >> 1; return b.length ? (b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2) : 0; };
  const ref = S.refId && R.has(S.refId) ? S.spectra.find(q => q.id === S.refId) : null;      // the spectrum the user set the range on is the reference; otherwise the median
  const ms = ref ? dec(ref, R.get(ref.id).iStart) : med(st), me = ref ? dec(ref, R.get(ref.id).iEnd) : med(en);
  for (const s of S.spectra) { let r = R.get(s.id); if (!r) continue;
    const near = t => { const v = s.pk.v; let k = 0; for (let i = 1; i < v.length; i++) if (Math.abs(dec(s, v[i]) - t) < Math.abs(dec(s, v[k]) - t)) k = i; return k; };
    const badS = Math.abs(dec(s, r.iStart) - ms) > RANGE_TOL, badE = Math.abs(dec(s, r.iEnd) - me) > RANGE_TOL;
    if (badS || badE || r.clipped) { const kS = badS || r.clipped ? near(ms) : r.kS, kE = badE || r.clipped ? near(me) : r.kE; if (kE > kS) { r = applyCuts(s.pk, kS, kE); r.adjusted = true; R.set(s.id, r); } }
    r.tStart = dec(s, r.iStart); r.tEnd = dec(s, r.iEnd); r.dStart = r.tStart - ms; r.dEnd = r.tEnd - me; r.off = Math.abs(r.dStart) > RANGE_TOL || Math.abs(r.dEnd) > RANGE_TOL; }
  return R;
}

// ---------------- γ(τ) plots: the same axes for the whole set ----------------
function axes() {
  let a = Infinity, b = -Infinity, g = 0;
  for (const s of S.spectra) if (s.pk) { const lt = s.drt.lt; a = Math.min(a, lt[0]); b = Math.max(b, lt[lt.length - 1]); g = Math.max(g, s.pk.gmax); }
  if (!isFinite(a)) { a = Math.log(1e-6); b = Math.log(100); g = 1; }
  return {a, b, g: g * 1.08 || 1};
}
const GEO = {L: 62, R: 16, T: 8, B: 40, H: 190};
function mapX(ax, W) { const pw = W - GEO.L - GEO.R;
  if (S.xlog) return {X: lt => GEO.L + (lt - ax.a) / (ax.b - ax.a) * pw, inv: px => ax.a + (px - GEO.L) / pw * (ax.b - ax.a), pw};
  const t1 = Math.exp(ax.b); return {X: lt => GEO.L + Math.exp(lt) / t1 * pw, inv: px => Math.log(Math.max(1e-300, (px - GEO.L) / pw * t1)), pw}; }
function draw(cv, s, ax, res) {
  const W = cv.parentElement.clientWidth || 600, r = window.devicePixelRatio || 1, {L, T, B, H} = GEO, ph = H - T - B, mp = mapX(ax, W), pw = mp.pw;
  cv.width = W * r; cv.height = H * r; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
  const Y = v => T + ph - v / ax.g * ph, X = mp.X;
  g.font = '12px -apple-system, "Segoe UI", sans-serif'; g.fillStyle = '#1d2329'; g.strokeStyle = '#c9ced5'; g.lineWidth = 1;
  g.strokeRect(L + .5, T + .5, pw, ph); g.beginPath(); g.textAlign = 'center'; g.textBaseline = 'top';
  if (S.xlog) { for (let e = Math.ceil(ax.a / Math.LN10); e <= Math.floor(ax.b / Math.LN10); e++) { const x = Math.round(X(e * Math.LN10)) + .5; g.moveTo(x, T + ph); g.lineTo(x, T + ph - 5);
      g.fillText('10', x - 4, T + ph + 8); g.font = '9px -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'left'; g.fillText(String(e).replace('-', '−'), x + 3, T + ph + 4); g.font = '12px -apple-system, "Segoe UI", sans-serif'; g.textAlign = 'center'; } }
  else { const t1 = Math.exp(ax.b), n = Math.max(3, pw / 90), raw = t1 / n, p10 = Math.pow(10, Math.floor(Math.log10(raw))), fr = raw / p10, st = (fr < 1.5 ? 1 : fr < 3.5 ? 2 : fr < 7.5 ? 5 : 10) * p10;
    for (let v = 0; v <= t1 * 1.0001; v += st) { const x = Math.round(L + v / t1 * pw) + .5; g.moveTo(x, T + ph); g.lineTo(x, T + ph - 5); g.fillText(String(+v.toPrecision(3)), x, T + ph + 6); } }
  g.textAlign = 'right'; g.textBaseline = 'middle';
  { const raw = ax.g / 3.5, p10 = Math.pow(10, Math.floor(Math.log10(raw))), fr = raw / p10, st = (fr < 1.5 ? 1 : fr < 3.5 ? 2 : fr < 7.5 ? 5 : 10) * p10, dec = Math.max(0, -Math.floor(Math.log10(st) + 1e-9));
    for (let v = 0; v <= ax.g; v += st) { const y = Math.round(Y(v)) + .5; g.moveTo(L, y); g.lineTo(L + 5, y); g.fillText(v.toFixed(dec), L - 6, y); } }
  g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText('τ (s)', L + pw / 2, H - 6);
  g.save(); g.translate(15, T + ph / 2); g.rotate(-Math.PI / 2); g.fillText('γ (Ω)', 0, 0); g.restore();
  if (!s.pk) return;
  const lt = s.drt.lt, gm = s.drt.g, pk = s.pk, K = pk.seg.length;
  g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
  pk.seg.forEach((q, k) => {                      // contact (grey), R_ct range (blue), diffusion (orange)
    const col = res && k < res.nL ? '#8c8c8c' : res && k >= K - res.nR ? '#e08a00' : '#1f77b4';
    g.beginPath(); g.moveTo(X(lt[q.a]), Y(0)); for (let i = q.a; i <= q.b; i++) g.lineTo(X(lt[i]), Y(gm[i])); g.lineTo(X(lt[q.b]), Y(0)); g.closePath(); g.fillStyle = col + (col === '#1f77b4' ? '55' : '33'); g.fill(); });
  g.strokeStyle = '#b5bcc6'; g.setLineDash([3, 3]); g.beginPath();                       // every minimum is a possible limit
  for (let k = 1; k < pk.v.length - 1; k++) { const x = Math.round(X(lt[pk.v[k]])) + .5; g.moveTo(x, T); g.lineTo(x, T + ph); } g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#111'; g.lineWidth = 1.6; g.beginPath(); for (let i = 0; i < gm.length; i++) { const x = X(lt[i]), y = Y(gm[i]); i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
  if (res) { g.lineWidth = 2; g.strokeStyle = res.off ? '#b00' : res.adjusted ? '#d97706' : '#1f5fbf';              // the two limits of the R_ct range
    for (const i of [res.iStart, res.iEnd]) { const x = Math.round(X(lt[i])); g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ph); g.stroke(); g.fillStyle = g.strokeStyle; g.beginPath(); g.moveTo(x - 5, T); g.lineTo(x + 5, T); g.lineTo(x, T + 7); g.closePath(); g.fill(); } }
  if (cv._drag) { g.fillStyle = 'rgba(31,95,191,.13)'; g.fillRect(Math.min(cv._drag.x0, cv._drag.x1), T, Math.abs(cv._drag.x1 - cv._drag.x0), ph); }
  g.restore();
}

// ---------------- choosing the range on any plot: double-click a place, or drag from left to right; it snaps to the nearest minimum ----------------
function nearestCut(s, ltv) { const lt = s.drt.lt, v = s.pk.v; let k = 0; for (let i = 1; i < v.length; i++) if (Math.abs(lt[v[i]] - ltv) < Math.abs(lt[v[k]] - ltv)) k = i; return k; }
function setRule(s, kStart, kEnd) {
  const K = s.pk.seg.length; if (kEnd <= kStart) return msg('The range needs at least one peak between its two limits');
  S.rule = {nL: kStart, nR: K - kEnd}; S.touched = s.name; S.refId = s.id; msg(`Range set on ${s.name}: ${kStart} peak${kStart === 1 ? '' : 's'} left out on the left, ${K - kEnd} on the right — applied to all spectra`);
  if (NQP.log) NQP.log('drt_rule', S.rule); render();
}
function hook(cv, s) {
  const ax = () => mapX(axes(), cv.parentElement.clientWidth || 600);
  cv.ondblclick = e => { if (!s.pk) return; const k = nearestCut(s, ax().inv(e.offsetX)), r = results().get(s.id), ks = r.kS, ke = r.kE;
    Math.abs(k - ks) <= Math.abs(k - ke) ? setRule(s, k, Math.max(ke, k + 1)) : setRule(s, Math.min(ks, k - 1), k); };
  cv.onpointerdown = e => { if (!s.pk) return; cv._drag = {x0: e.offsetX, x1: e.offsetX}; cv.setPointerCapture(e.pointerId); };
  cv.onpointermove = e => { if (!cv._drag) return; cv._drag.x1 = e.offsetX; if (Math.abs(cv._drag.x1 - cv._drag.x0) > 6) draw(cv, s, axes(), results().get(s.id)); };
  cv.onpointerup = () => { const d = cv._drag; cv._drag = null; if (!d) return; if (d.x1 - d.x0 > 6) { const m = ax(); setRule(s, nearestCut(s, m.inv(d.x0)), nearestCut(s, m.inv(d.x1))); } else draw(cv, s, axes(), results().get(s.id)); };
}

// ---------------- page layout ----------------
function build() {
  const tb = $('.toolbar[data-pane=drt]'), sec = $('section[data-pane=drt]'); if (!tb || !sec) return;
  tb.innerHTML = `
    <label class="rdrop" id="d_drop" title="Drop the impedance files of one cell here, or click to choose several">
      <input type="file" id="d_file" multiple accept=".txt,.csv,.dat,.mpt,.dta,.z,.tsv" hidden>
      <span class="ic">⇣</span><span><b>Drop EIS files here</b><br><u>or click to choose files…</u></span></label>
    <button type="button" id="d_from" title="Use the spectra that are loaded in the EIS ECM tab">Take the EIS ECM spectra</button>
    <label title="Regularisation parameter of the DRT; one value for the whole set">λ <input type="text" id="d_lam" value="1e-3" style="width:64px"></label>
    <label>τ axis <select id="d_x"><option value="log">log</option><option value="lin">linear</option></select></label>
    <span class="sp"></span>
    <button type="button" id="d_clear">Clear</button>
    <button type="button" id="d_export" class="primary" title="Table with R_contact and R_ct of every spectrum">Export results</button>`;
  sec.innerHTML = `
    <div id="d_msg" style="padding:6px 16px 0;font-size:13px;color:var(--muted);min-height:6px"></div>
    <div id="d_cite" style="margin:6px 16px 0;padding:7px 12px;border:1px solid #e3a5a5;background:#fdf1f1;border-radius:7px;font-size:13px;color:#b00000;font-weight:600">
      ⚠ The DRT is computed with the DRTtools method (Gaussian radial basis functions, Tikhonov regularisation; Ciucci group). If you use these results you must cite: ${esc(CITE)}</div>
    <div id="d_warn" hidden style="margin:6px 16px 0;padding:7px 12px;border:1px solid #f0d9a0;background:#fff6e0;border-radius:7px;font-size:13px"></div>
    <div class="egrid">
      <div id="d_plots"></div>
      <div class="mod" id="d_res">
        <div class="bar"><span class="t">Results</span><span class="opts gmuted" id="d_sum"></span></div>
        <div id="d_tab"></div>
        <div class="note">Areas under γ(ln τ) between its minima. Grey: contact peak(s), left out. Blue: the R_ct range. Orange: diffusion, left out.
          To change the range, double-click near a minimum (dashed line) on any plot, or drag from left to right; the limits snap to the nearest minimum and the same rule is applied to every spectrum.
          ECM: R_ct from the equivalent-circuit fit of the EIS ECM tab, for comparison.</div>
      </div>
    </div>`;
  $('#d_file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#d_drop');
  for (const el of [dz, sec]) {
    el.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    el.addEventListener('dragleave', () => dz.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  }
  $('#d_from').onclick = () => { const src = eis().state().spectra.filter(q => !S.spectra.some(s => s.name === q.name)); if (!src.length) return msg('No new spectra in the EIS ECM tab'); addSpectra(src); };
  $('#d_lam').onchange = e => { const v = +e.target.value; if (!(v > 0)) { e.target.value = S.lam; return; } S.lam = v; for (const s of S.spectra) { s.drt = null; s.pk = null; } render(); compute(S.spectra.slice()); };
  $('#d_x').onchange = e => { S.xlog = e.target.value === 'log'; drawAll(); save(); };
  $('#d_clear').onclick = () => { S.spectra = []; S.touched = null; S.refId = null; S.rule = {nL: 1, nR: 1}; S.ecmMode = 3; msg(''); render(); };
  $('#d_export').onclick = exportCsv;
  let rt; new ResizeObserver(() => { if (sec.hidden) return; clearTimeout(rt); rt = setTimeout(drawAll, 80); }).observe(sec);
}
function drawAll() { const ax = axes(), R = results(); for (const s of S.spectra) { const cv = $('#dcv_' + s.id); if (cv) draw(cv, s, ax, R.get(s.id)); } }
function head(s, r) {
  return `<span class="t" title="${esc(s.name)}"><bdi>${esc(s.name)}</bdi></span><span class="opts">${!s.drt ? 'computing…' : s.drt.failed ? '<b style="color:#b00">no DRT</b>'
    : `R_contact <b>${fmt(r.R_contact)}</b> · R_ct <b>${fmt(r.R_ct)}</b> Ω · ${s.pk.seg.length} peaks` + (r.off ? ' · <b style="color:#b00">check the range</b>' : r.adjusted ? ' · <span style="color:#d97706">range moved to match the set</span>' : '')}</span>`;
}
function renderTable() {
  const R = results();
  const rows = S.spectra.map(s => { const r = R.get(s.id), e = s.ecm && !s.ecm.failed && s.ecm.mode === S.ecmMode ? s.ecm : null, dv = r && e ? 100 * (r.R_ct - e.R_ct) / e.R_ct : null;
    return `<tr data-id="${s.id}" style="cursor:pointer"><td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left" title="${esc(s.name)}"><bdi>${esc(s.name)}</bdi></td>
      <td style="text-align:right">${r ? fmt(r.R_contact) : ''}</td><td style="text-align:right"><b>${r ? fmt(r.R_ct) : s.drt ? 'failed' : '…'}</b></td>
      <td style="text-align:right;color:var(--muted)">${e ? fmt(e.R_ct) : s.ecm && s.ecm.failed ? 'failed' : '…'}</td>
      <td style="text-align:right;${dv != null && Math.abs(dv) > 10 ? 'color:#b00;font-weight:600' : 'color:var(--muted)'}">${dv == null ? '' : (dv > 0 ? '+' : '') + dv.toFixed(1)}</td>
      <td title="${r && r.adjusted && !r.off ? 'Counting peaks put a limit far from where it is for the rest of the set, so the nearest minimum was used' : r && r.off ? `start ${r.dStart >= 0 ? '+' : ''}${r.dStart.toFixed(2)}, end ${r.dEnd >= 0 ? '+' : ''}${r.dEnd.toFixed(2)} decades from the reference` : ''}" style="${r && r.off ? 'color:#b00;font-weight:600' : r && r.adjusted ? 'color:#d97706' : 'color:var(--muted)'}">${r ? (r.off ? 'check' : r.adjusted ? 'adjusted' : 'ok') : ''}</td>
      <td class="x" title="Remove">✕</td></tr>`; }).join('');
  $('#d_tab').innerHTML = S.spectra.length ? `<table class="pk"><thead><tr><th>Spectrum</th><th style="text-align:right">R_contact<br>(Ω)</th><th style="text-align:right">R_ct DRT<br>(Ω)</th>
      <th style="text-align:right" title="Equivalent-circuit fit, ${S.ecmMode} semicircles for the whole set">R_ct ECM<br>(${S.ecmMode} semic.)</th><th style="text-align:right" title="DRT relative to ECM">Δ<br>(%)</th>
      <th title="Whether the start and the end of the range sit where they do for the rest of the set">range</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="gmuted" style="padding:8px 2px">No spectra yet.</div>';
  $('#d_tab').querySelectorAll('tr[data-id]').forEach(tr => { const q = S.spectra.find(z => z.id === tr.dataset.id);
    tr.onclick = e => { if (e.target.classList.contains('x')) { S.spectra = S.spectra.filter(z => z !== q); render(); } else { const c = $('#dcard_' + q.id); if (c) c.scrollIntoView({behavior: 'smooth', block: 'center'}); } }; });
  $('#d_sum').textContent = S.spectra.length ? `λ ${S.lam} · ${S.rule.nL} peak${S.rule.nL === 1 ? '' : 's'} out on the left, ${S.rule.nR} on the right` + (S.touched ? '' : ' (default)') : '';
  const off = [...R.values()].filter(r => r.off).length, w = $('#d_warn');
  if (off) { w.hidden = false; w.innerHTML = `<b>${off} of ${S.spectra.length} spectra: the range starts or ends more than ${RANGE_TOL} decade away from the rest of the set</b> (marked red). Their peaks split or merge differently — look at those plots, or try another λ.`; } else w.hidden = true;
  for (const s of S.spectra) { const c = $('#dcard_' + s.id); if (c) $('.bar', c).innerHTML = head(s, R.get(s.id)); }
}
function render() {
  save();
  const sec = $('section[data-pane=drt]'); if (!sec || sec.hidden) return;
  $('#d_plots').innerHTML = S.spectra.length ? S.spectra.map(s => `<div class="mod" id="dcard_${s.id}"><div class="bar"></div><div class="plot"><canvas id="dcv_${s.id}" style="touch-action:none;cursor:col-resize"></canvas></div></div>`).join('')
    : '<div class="mod"><div class="note" style="padding:14px 4px">Drop the impedance files of one cell (frequency, Z′, Z″) on the box above, or take the spectra already loaded in the EIS ECM tab. Each spectrum gets its γ(τ) plot here, one below the other.</div></div>';
  for (const s of S.spectra) hook($('#dcv_' + s.id), s);
  renderTable(); drawAll();
}
function exportCsv() {
  if (!S.spectra.length) return msg('Nothing to export');
  const R = results(), n6 = v => String(+(+v).toPrecision(6));
  const rows = [['spectrum', 'R_contact DRT (ohm)', 'R_ct DRT (ohm)', `R_ct ECM (ohm, ${S.ecmMode} semicircles)`, 'range start tau (s)', 'range end tau (s)', 'range check', 'lambda', 'peaks left out left', 'peaks left out right']];
  for (const s of S.spectra) { const r = R.get(s.id), e = s.ecm && !s.ecm.failed ? s.ecm : null;
    rows.push([s.name, r ? n6(r.R_contact) : '', r ? n6(r.R_ct) : '', e ? n6(e.R_ct) : '', r ? n6(Math.pow(10, r.tStart)) : '', r ? n6(Math.pow(10, r.tEnd)) : '', r ? (r.off ? 'check' : r.adjusted ? 'adjusted' : 'ok') : '', S.lam, S.rule.nL, S.rule.nR]); }
  rows.push([]); rows.push(['DRT computed with the DRTtools method. Cite: ' + CITE]);
  const csv = rows.map(r => r.map(c => /[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c).join(',')).join('\r\n') + '\r\n';
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], {type: 'text/csv'})); a.download = `${stamp}_EIS_DRT_Rct.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  if (NQP.log) NQP.log('drt_export', {n: S.spectra.length});
}

// the set (spectra, DRT, range rule, λ, axis) is kept in this browser and comes back when the page is opened again
let saveT = null, ready = false;
function save() {
  if (!ready || !NQP.idb) return;
  clearTimeout(saveT); saveT = setTimeout(() => { NQP.idb.set('drt', {...S, seq}).catch(() => {}); }, 600);
}
async function restore() {
  try { const r = NQP.idb && await NQP.idb.get('drt');
    if (r && Array.isArray(r.spectra)) { const {seq: q, ...st} = r; Object.assign(S, st); seq = q || r.spectra.length;
      for (const z of S.spectra) if (z.ecm && z.ecm.v !== eis().FITV) { z.ecm = null; S.ecmMode = 3; }      // ECM comparison made with an older fitting method: redo
      if ($('#d_lam')) { $('#d_lam').value = S.lam; $('#d_x').value = S.xlog ? 'log' : 'lin'; } } } catch {}
  ready = true;
}
window.addEventListener('DOMContentLoaded', async () => { build(); await restore(); render(); if (S.spectra.length) compute(S.spectra.filter(s => !s.drt)); window.addEventListener('cellpeek:tab', () => render()); });
NQP.drt = {state: () => S, ...API};
})();
