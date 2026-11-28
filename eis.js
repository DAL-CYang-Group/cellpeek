// CellPeek — EIS ECM tab: batch equivalent-circuit fitting of impedance spectra.
// Model (series):  [L] + R_HFI + ZARC_1 (contact) + ZARC_2 [+ ZARC_3] [+ diffusion tail]
//   ZARC_k = R_k / (1 + (jωτ_k)^α_k)      a depressed semicircle (R parallel to a constant-phase element), diameter R_k
//   tail   = W (jω)^(-p)                  p = 0.5 is a Warburg line (45°); p is fitted between 0.3 and 0.9
// Output:  R_HFI = series resistance (high-frequency intercept with the real axis)
//          R_ct  = R_2 (+ R_3): summed diameters of the semicircle(s) after the first one.
// The first (highest-frequency) semicircle is the contact impedance (active particles / current collector) and is not part of R_ct.
// Fit: complex non-linear least squares (Levenberg–Marquardt), modulus weighting, several starting points.
'use strict';
(function () {
const TWO_PI = 2 * Math.PI;

// ---------------- reading files ----------------
// Returns [{name, f[], zr[], zi[]}] sorted from high to low frequency; zi = Im(Z) (negative for capacitive behaviour).
function parseEIS(text, name) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  const split = ln => { const t = ln.trim(); if (t.includes('\t')) return t.split('\t'); if (t.includes(';')) return t.split(';'); const c = t.split(','); return c.length >= 3 ? c : t.split(/\s+/); };
  const num = s => { s = String(s).trim(); if (s === '') return NaN; if (/^-?\d+,\d+([eE][-+]?\d+)?$/.test(s)) s = s.replace(',', '.'); const v = Number(s); return Number.isFinite(v) ? v : NaN; };
  const isNumRow = c => c.length >= 3 && c.filter(x => !isNaN(num(x))).length >= Math.min(3, c.length);
  // header: the last non-numeric line before the first run of numeric rows
  let start = -1;
  for (let i = 0; i < lines.length; i++) { const c = split(lines[i]); if (isNumRow(c) && i + 2 < lines.length && isNumRow(split(lines[i + 1])) && isNumRow(split(lines[i + 2]))) { start = i; break; } }
  if (start < 0) throw new Error('no table of numbers found');
  let hdr = null;
  for (let i = start - 1; i >= Math.max(0, start - 3); i--) { const c = split(lines[i]).map(x => x.trim().toLowerCase()); if (c.length >= 3 && c.some(x => /freq|^f$|^f[\/ (]|hz/.test(x))) { hdr = c; break; } }
  let cf = 0, cr = 1, ci = 2, neg = null;        // neg: the column holds −Im(Z)
  if (hdr) {
    const find = re => hdr.findIndex(x => re.test(x));
    const a = find(/freq|^f$|^f[\/ (]/), b = find(/re\(z\)|zreal|z_?re|^z'(?!')|z′(?!′)|^re[ (\/]|real/), c = find(/im\(z\)|zimag|z_?im|z''|z″|^-?im[ (\/]|imag/);
    if (a >= 0 && b >= 0 && c >= 0) { cf = a; cr = b; ci = c; neg = /^-|−|-im|-z''/.test(hdr[c]) || /-im\(z\)/.test(hdr[c]); }
  }
  const rows = [];
  for (let i = start; i < lines.length; i++) { const c = split(lines[i]); if (c.length <= Math.max(cf, cr, ci)) continue; const f = num(c[cf]), r = num(c[cr]), m = num(c[ci]); if (f > 0 && isFinite(r) && isFinite(m)) rows.push([f, r, m]); }
  if (rows.length < 6) throw new Error('fewer than 6 data points');
  if (neg === null) { const s = rows.map(r => r[2]).sort((a, b) => a - b); neg = s[s.length >> 1] > 0; }   // no header: a mostly positive column is −Im(Z)
  // several sweeps in one file: a new sweep starts when the frequency jumps back
  const dir = Math.sign(Math.log(rows[Math.min(5, rows.length - 1)][0] / rows[0][0])) || -1, sweeps = [[]];
  for (let i = 0; i < rows.length; i++) { if (i && Math.sign(Math.log(rows[i][0] / rows[i - 1][0])) === -dir && Math.abs(Math.log(rows[i][0] / rows[i - 1][0])) > 2) sweeps.push([]); sweeps[sweeps.length - 1].push(rows[i]); }
  const base = String(name || 'spectrum').replace(/\.[A-Za-z0-9]{1,5}$/, '');
  return sweeps.filter(s => s.length >= 6).map((s, k, all) => { s.sort((a, b) => b[0] - a[0]);
    return {name: all.length > 1 ? `${base} #${k + 1}` : base, f: s.map(r => r[0]), zr: s.map(r => r[1]), zi: s.map(r => neg ? -r[2] : r[2])}; });
}

// ---------------- model ----------------
const sig = u => 1 / (1 + Math.exp(-u)), logit = v => Math.log(v / (1 - v));
const A_LO = 0.5, A_HI = 1, P_LO = 0.3, P_HI = 0.9;
// cfg = {n: 2|3, tail: bool, L: bool};  q = transformed parameter vector
function unpack(q, cfg) {
  let i = 0; const o = {R0: Math.exp(q[i++]), L: cfg.L ? Math.exp(q[i++]) : 0, arcs: [], W: 0, p: 0.5};
  for (let k = 0; k < cfg.n; k++) o.arcs.push({R: Math.exp(q[i++]), tau: Math.exp(q[i++]), a: A_LO + (A_HI - A_LO) * sig(q[i++])});
  if (cfg.tail) { o.W = Math.exp(q[i++]); o.p = P_LO + (P_HI - P_LO) * sig(q[i++]); }
  return o;
}
function pack(o, cfg) {
  const q = [Math.log(o.R0)]; if (cfg.L) q.push(Math.log(o.L));
  for (const a of o.arcs) q.push(Math.log(a.R), Math.log(a.tau), logit((Math.min(A_HI - 1e-3, Math.max(A_LO + 1e-3, a.a)) - A_LO) / (A_HI - A_LO)));
  if (cfg.tail) q.push(Math.log(o.W), logit((o.p - P_LO) / (P_HI - P_LO)));
  return q;
}
function zarc(R, tau, a, w) { const m = Math.pow(w * tau, a), c = 1 + m * Math.cos(a * Math.PI / 2), s = m * Math.sin(a * Math.PI / 2), d = c * c + s * s; return [R * c / d, -R * s / d]; }
function zModel(o, f) {                          // -> [re, im]
  const w = TWO_PI * f; let re = o.R0, im = w * o.L;
  for (const a of o.arcs) { const z = zarc(a.R, a.tau, a.a, w); re += z[0]; im += z[1]; }
  if (o.W) { const m = o.W * Math.pow(w, -o.p); re += m * Math.cos(o.p * Math.PI / 2); im -= m * Math.sin(o.p * Math.PI / 2); }
  return [re, im];
}

// ---------------- Levenberg–Marquardt ----------------
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => r.concat(b[i]));
  for (let c = 0; c < n; c++) { let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-300) return null; [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) { const k = M[r][c] / M[c][c]; if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j]; } }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) { let s = M[r][n]; for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j]; x[r] = s / M[r][r]; }
  return x.every(Number.isFinite) ? x : null;
}
function lm(res, q0, maxIt) {
  let q = q0.slice(), r = res(q), cost = r.reduce((s, v) => s + v * v, 0), lam = 1e-2; const n = q.length;
  for (let it = 0; it < maxIt; it++) {
    const J = []; for (let j = 0; j < n; j++) { const h = 1e-5 * Math.max(1, Math.abs(q[j])), q2 = q.slice(); q2[j] += h; const r2 = res(q2); J.push(r2.map((v, i) => (v - r[i]) / h)); }
    const A = [], g = new Array(n).fill(0);
    for (let a = 0; a < n; a++) { A.push(new Array(n).fill(0)); for (let i = 0; i < r.length; i++) g[a] += J[a][i] * r[i]; }
    for (let a = 0; a < n; a++) for (let b = a; b < n; b++) { let s = 0; for (let i = 0; i < r.length; i++) s += J[a][i] * J[b][i]; A[a][b] = A[b][a] = s; }
    let ok = false;
    for (let t = 0; t < 12; t++) {
      const B = A.map((row, i) => row.map((v, j) => i === j ? v * (1 + lam) + 1e-12 : v)), d = solve(B, g.map(v => -v));
      if (!d) { lam *= 10; continue; }
      const q2 = q.map((v, i) => v + Math.max(-3, Math.min(3, d[i]))), r2 = res(q2), c2 = r2.reduce((s, v) => s + v * v, 0);
      if (isFinite(c2) && c2 < cost) { const rel = (cost - c2) / (cost || 1); q = q2; r = r2; cost = c2; lam = Math.max(lam / 4, 1e-10); ok = true; if (rel < 1e-10) it = maxIt; break; }
      lam *= 6;
    }
    if (!ok) break;
  }
  return {q, cost};
}

// ---------------- shape analysis: tail, starting values ----------------
function shape(d) {
  const n = d.f.length, y = d.zi.map(v => -v);
  const ys = y.map((v, i) => { const a = [y[Math.max(0, i - 1)], v, y[Math.min(n - 1, i + 1)]].sort((p, q) => p - q); return a[1]; });   // 3-point median
  const ymax = Math.max(...ys), iInd = ys.findIndex(v => v > 0);                  // points before iInd are inductive (−Z″ < 0)
  // tail: at the low-frequency end −Z″ rises again after a minimum that follows a semicircle apex
  let run = n - 1; while (run > 0 && ys[run] >= ys[run - 1] - 1e-4 * ymax) run--;
  let apex = -1; for (let i = Math.max(1, iInd); i < run; i++) if (ys[i] >= ys[i - 1] && ys[i] >= ys[i + 1] && (apex < 0 || ys[i] > ys[apex])) apex = i;
  const tail = (n - 1 - run) >= 3 && apex >= 0 && ys[n - 1] - ys[run] > 0.06 * ymax && ys[run] < 0.92 * ys[apex];
  return {y, ys, ymax, iInd: Math.max(0, iInd), tail, iMin: tail ? run : n - 1, inductive: y.filter(v => v < 0).length >= 2};
}
function starts(d, sh, cfg) {
  const n = d.f.length, i0 = sh.iInd, i1 = cfg.tail ? sh.iMin : n - 1;
  const zmin = Math.min(...d.zr.slice(i0)), R0s = [Math.max(zmin * 0.97, 1e-9), Math.max(zmin - 0.5 * Math.max(0, sh.y[i0]), zmin * 0.5, 1e-9)];
  const Rtot = Math.max((cfg.tail ? d.zr[i1] : d.zr[n - 1] + 0.6 * Math.max(0, sh.y[n - 1])) - zmin, 1e-6 * Math.abs(zmin) + 1e-9);
  const lf = k => Math.log(d.f[Math.round(i0 + (i1 - i0) * k)]), tauAt = k => 1 / (TWO_PI * Math.exp(lf(k)));
  const peaks = []; for (let i = i0 + 1; i < i1; i++) if (sh.ys[i] > sh.ys[i - 1] && sh.ys[i] >= sh.ys[i + 1]) peaks.push(1 / (TWO_PI * d.f[i]));
  const N = cfg.n, tauSets = N === 2 ? [[tauAt(.25), tauAt(.7)], [tauAt(.1), tauAt(.55)], [tauAt(.4), tauAt(.85)]] : [[tauAt(.15), tauAt(.5), tauAt(.82)], [tauAt(.08), tauAt(.35), tauAt(.7)], [tauAt(.3), tauAt(.6), tauAt(.9)]];
  if (peaks.length >= 1) { const p = peaks.slice().sort((a, b) => a - b), s = []; for (let k = 0; k < N; k++) s.push(p[Math.round(k * (p.length - 1) / Math.max(1, N - 1))]);
    for (let k = 1; k < N; k++) if (s[k] <= s[k - 1] * 2) s[k] = s[k - 1] * 6; if (p.length === 1) { s[N - 1] = p[0]; for (let k = N - 2; k >= 0; k--) s[k] = s[k + 1] / 12; } tauSets.push(s); }
  const splits = N === 2 ? [[.15, .85], [.4, .6], [.7, .3]] : [[.1, .3, .6], [.2, .4, .4], [.1, .6, .3], [.34, .33, .33]];
  const wl = TWO_PI * d.f[n - 1], W0 = Math.max(sh.y[n - 1] - sh.y[sh.iMin], 0.05 * sh.ymax) * Math.sqrt(wl) / Math.SQRT1_2, L0 = sh.inductive ? Math.max(-sh.y[0], 1e-12) / (TWO_PI * d.f[0]) : 0;
  const out = [];
  for (const ts of tauSets) for (const sp of splits) out.push(pack({R0: R0s[out.length % 2], L: L0 || 1e-9, arcs: ts.map((t, k) => ({R: Rtot * sp[k], tau: t, a: 0.85})), W: W0, p: 0.5}, cfg));
  return out;
}

// ---------------- fitting one spectrum ----------------
function fitCfg(d, sh, cfg) {
  const n = d.f.length, mod = d.f.map((_, i) => Math.hypot(d.zr[i], d.zi[i]) || 1);
  const tLo = Math.log(0.05 / (TWO_PI * d.f[0])), tHi = Math.log((cfg.tail ? 1 : 8) / (TWO_PI * d.f[n - 1]));   // time constants stay inside the measured window
  const res = q => { const o = unpack(q, cfg), r = new Array(2 * n);
    for (let i = 0; i < n; i++) { const z = zModel(o, d.f[i]); r[2 * i] = (z[0] - d.zr[i]) / mod[i]; r[2 * i + 1] = (z[1] - d.zi[i]) / mod[i]; }
    for (const a of o.arcs) { const lt = Math.log(a.tau); r.push(lt < tLo ? 3 * (tLo - lt) : lt > tHi ? 3 * (lt - tHi) : 0); }
    return r; };
  let best = null;
  for (const q0 of starts(d, sh, cfg)) { const r = lm(res, q0, 40); if (isFinite(r.cost) && (!best || r.cost < best.cost)) best = r; }
  if (!best) return null;
  best = lm(res, best.q, 300);
  const o = unpack(best.q, cfg); o.arcs.sort((a, b) => a.tau - b.tau);          // arc 1 = highest frequency = contact
  let ss = 0; for (let i = 0; i < n; i++) { const z = zModel(o, d.f[i]); ss += ((z[0] - d.zr[i]) ** 2 + (z[1] - d.zi[i]) ** 2) / (mod[i] * mod[i]); }
  const k = best.q.length, N2 = 2 * n;
  return {cfg, o, cost: ss, err: 100 * Math.sqrt(ss / n), bic: N2 * Math.log(ss / N2 + 1e-300) + k * Math.log(N2)};
}
// opt = {n: 'auto'|2|3, tail: 'auto'|'on'|'off'}
// Inductive points at the high-frequency end (−Z″ < 0: cables, cell hardware), two ways, chosen with opt.inductive:
//   'fit'  (default) — all measured points are used and an inductor is in the model
//   'skip'           — these points are left out of the fit and the model has no inductor (nSkip = number of points left out).
//                      Smaller fit error, because there Z′ changes with frequency too, which an ideal inductor cannot follow; R_HFI and R_contact change with it.
const FITV = 3;                                  // version of the fitting method (stored fits of an older version are redone)
function fitSpectrum(d0, opt = {}) {
  const k0 = opt.inductive === 'skip' ? shape(d0).iInd : 0, nSkip = k0 > 0 && d0.f.length - k0 >= 10 ? k0 : 0;
  const d = nSkip ? {f: d0.f.slice(nSkip), zr: d0.zr.slice(nSkip), zi: d0.zi.slice(nSkip)} : d0;
  const sh = shape(d), tail = opt.tail === 'on' ? true : opt.tail === 'off' ? false : sh.tail, L = nSkip ? false : sh.inductive;
  const run = n => fitCfg(d, sh, {n, tail, L});
  let fit, note = '';
  if (opt.n === 2 || opt.n === 3) fit = run(opt.n);
  else {                                         // auto: three semicircles only when the data clearly ask for a third one
    const f2 = run(2), f3 = run(3);
    const sum3 = f3 ? f3.o.arcs.reduce((s, a) => s + a.R, 0) : 0;
    const ok3 = f3 && f2 && f3.bic < f2.bic - 10 && f3.err < 0.8 * f2.err && f3.o.arcs.every(a => a.R > 0.03 * sum3) && f3.o.arcs.every((a, i, A) => !i || a.tau > 3 * A[i - 1].tau);
    fit = ok3 ? f3 : f2 || f3;
  }
  if (!fit) return null;
  const A = fit.o.arcs, Rct = A.slice(1).reduce((s, a) => s + a.R, 0);
  if (L) note = 'inductive points at high frequency: an inductor is included';
  // error shown and used for the "fits poorly" mark: the points with −Z″ ≥ 0 only. The inductive points are fitted too, but there Z′ also
  // changes with frequency, which an ideal inductor cannot follow; their misfit says nothing about the semicircles. errAll = all points.
  let ss = 0, nb = 0; for (let i = sh.iInd; i < d.f.length; i++) { const z = zModel(fit.o, d.f[i]), m2 = d.zr[i] * d.zr[i] + d.zi[i] * d.zi[i] || 1; ss += ((z[0] - d.zr[i]) ** 2 + (z[1] - d.zi[i]) ** 2) / m2; nb++; }
  const errBody = nb ? 100 * Math.sqrt(ss / nb) : fit.err;
  return {v: FITV, n: A.length, tail, tailAuto: sh.tail, L, nSkip, R_HFI: fit.o.R0, R_contact: A[0].R, R_ct: Rct, R_tot: A[0].R + Rct, err: errBody, errAll: fit.err, model: fit.o, note};
}

const API = {parseEIS, fitSpectrum, zModel, zarc, shape, FITV};
if (typeof module !== 'undefined' && module.exports) { module.exports = API; return; }
if (typeof document === 'undefined') return;

// =====================================================================================================================
// page
// =====================================================================================================================
const NQP = window.NQP = window.NQP || {};
const $ = (s, el) => (el || document).querySelector(s);
const esc = t => String(t ?? '').replace(/[&<>"]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[ch]));
const ARC_COL = ['#8c8c8c', '#1f77b4', '#2ca02c'];           // contact, then the R_ct semicircle(s)
const CITE = ['How to cite the source code: Chongyin Yang, cellpeek-eis: ultra-fast batch equivalent-circuit fitting of impedance spectra of Li-ion cells, Zenodo (2026), doi:10.5281/zenodo.24283256',
  'Circuit and definition of R_ct: A.S. Keefe, R. Weber, I.G. Hill, J.R. Dahn, J. Electrochem. Soc. 167 (2020) 120507, doi:10.1149/1945-7111/abaa1b; D.W. Abarbanel, K.J. Nelson, J.R. Dahn, J. Electrochem. Soc. 163 (2016) A522, doi:10.1149/2.0901603jes'];
const doiLinks = t => esc(t).replace(/doi:(10\.[^\s;,]+)/g, '<a href="https://doi.org/$1" target="_blank" rel="noopener">doi:$1</a>');
const POOR = 2.5;                                            // fit error (%) above which a fit is marked as poor
// One data set = the spectra of one cell over time. Rule: the whole set is fitted with the same model —
// 3 semicircles by default; 2 can be chosen. The tail is judged per spectrum.
const S = {spectra: [], mode: 3, area: '', sym: false, skipL: true};       // skipL: leave the inductive points out of the fit (on by default)      // spectrum: {id, name, f, zr, zi, fit}
let seq = 0, busy = false;
const unit = () => (+S.area > 0 ? 'Ω cm²' : 'Ω');
const scale = () => (+S.area > 0 ? +S.area : 1) * (S.sym ? 0.5 : 1);      // area-specific; a symmetric cell holds two identical electrodes
const fmt = v => v == null || !isFinite(v) ? '—' : Math.abs(v) >= 1000 ? v.toFixed(0) : Math.abs(v) >= 100 ? v.toFixed(1) : Math.abs(v) >= 10 ? v.toFixed(2) : v.toFixed(3);
const msg = t => { const e = $('#e_msg'); if (e) e.textContent = t || ''; };
const good = s => s.fit && !s.fit.failed ? s.fit : null;
const natural = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});

async function addFiles(files) {
  let n = 0; const bad = [];
  for (const f of files) {
    try { for (const d of parseEIS(await f.text(), f.name)) { S.spectra.push({id: 'e' + (++seq), ...d, fit: null}); n++; } }
    catch (e) { bad.push(`${f.name}: ${e.message}`); }
  }
  S.spectra.sort((a, b) => natural.compare(a.name, b.name));                // a long-term series reads top to bottom
  msg((n ? `${n} spectr${n === 1 ? 'um' : 'a'} loaded` : '') + (bad.length ? `${n ? ' · ' : ''}Not read: ${bad.join('; ')}` : ''));
  if (n && NQP.log) NQP.log('eis_load', {n});
  render(); fitQueue(S.spectra.filter(s => !s.fit));
}
function refitAll() { for (const q of S.spectra) q.fit = null; render(); fitQueue(S.spectra.slice()); }
const secs = ms => (ms < 9995 ? (ms / 1000).toFixed(2) : (ms / 1000).toFixed(1)) + ' s';      // time from the first fit to the last, drawing included
function fitQueue(list) {                         // one spectrum at a time, so the page stays responsive
  if (busy) { fitQueue.more = (fitQueue.more || []).concat(list); return; }
  busy = true; let i = 0; const total = list.length, mode = S.mode, t0 = performance.now();
  const step = () => {
    if (i >= list.length || mode !== S.mode) { busy = false; if (mode === S.mode) msg(total ? `Fitted ${total} spectr${total === 1 ? 'um' : 'a'} with ${S.mode} semicircles in ${secs(performance.now() - t0)}` : ''); render();
      const m = fitQueue.more; fitQueue.more = null; if (m && m.length) fitQueue(m.filter(s => !s.fit)); return; }
    const s = list[i++]; msg(`Fitting ${i} / ${total} …`);
    if (!s.fit) { try { s.fit = fitSpectrum(s, {n: mode, tail: 'auto', inductive: S.skipL ? 'skip' : 'fit'}) || {failed: true}; } catch (e) { s.fit = {failed: true, note: e.message}; } }
    renderRow(s); setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

// ---------------- Nyquist plots: the same scale on both axes, and the same axes for every spectrum of the set ----------------
function niceStep(span, n) { const r = span / n, p = Math.pow(10, Math.floor(Math.log10(r))), f = r / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
function commonRange() {                          // in display units
  const k = scale(); let x0 = Infinity, x1 = -Infinity, y0 = 0, y1 = -Infinity;
  for (const s of S.spectra) { for (let i = 0; i < s.f.length; i++) { const x = s.zr[i] * k, y = -s.zi[i] * k; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    const f = good(s); if (f && f.R_HFI * k < x0) x0 = f.R_HFI * k; }
  if (!isFinite(x0)) return {xs: [0, 1], ys: [0, 0.4]};
  const px = (x1 - x0) * 0.05 || 1, dy = (y1 - y0) || 1;
  return {xs: [x0 - px, x1 + px], ys: [y0 - dy * 0.2, y1 + dy * 0.1]};       // room under the axis for the R_HFI / R_ct labels
}
let EXPORTING = false;                         // PNG export / copy: laid out at the picture width (8.5 cm), drawn at its final size
function drawNyq(cv, s, rg) {
  const W = EXPORTING ? EXPO.W : cv.parentElement.clientWidth || 600, r = EXPORTING ? EXPO.px(300) / EXPO.W : window.devicePixelRatio || 1, k = scale(), fit = good(s);   // picture: laid out at EXPO.W css px, drawn straight at 8.5 cm, 300 dpi
  const L = 66, R = 18, T = 10, B = 44, pw = W - L - R;
  let xs = rg.xs.slice(), ys = rg.ys.slice();
  const ph = Math.max(150, Math.min(520, Math.round(pw * (ys[1] - ys[0]) / (xs[1] - xs[0]))));
  const sc = Math.min(pw / (xs[1] - xs[0]), ph / (ys[1] - ys[0]));               // pixels per ohm, identical for the real and the imaginary axis
  { const cx = (xs[0] + xs[1]) / 2, hw = pw / sc / 2; xs = [cx - hw, cx + hw]; ys = [ys[0], ys[0] + ph / sc]; }
  const H = T + ph + B; cv.width = W * r; cv.height = H * r; cv.style.width = W + 'px'; cv.style.height = H + 'px';
  const g = cv.getContext('2d'); g.setTransform(r, 0, 0, r, 0, 0); g.clearRect(0, 0, W, H);
  const X = v => L + (v - xs[0]) * sc, Y = v => T + ph - (v - ys[0]) * sc;
  g.font = '12px -apple-system, "Segoe UI", sans-serif'; g.fillStyle = '#1d2329'; g.strokeStyle = '#c9ced5'; g.lineWidth = 1;
  const st = niceStep(xs[1] - xs[0], Math.max(3, pw / 90)), dec = Math.max(0, -Math.floor(Math.log10(st) + 1e-9)), tf = v => (+v.toFixed(dec)).toFixed(dec);
  g.strokeRect(L + .5, T + .5, pw, ph); g.beginPath();
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let v = Math.ceil(xs[0] / st) * st; v <= xs[1] + st * 1e-6; v += st) { const x = Math.round(X(v)) + .5; g.moveTo(x, T + ph); g.lineTo(x, T + ph - 5); g.fillText(tf(v), x, T + ph + 6); }
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = Math.ceil(ys[0] / st) * st; v <= ys[1] + st * 1e-6; v += st) { const y = Math.round(Y(v)) + .5; g.moveTo(L, y); g.lineTo(L + 5, y); g.fillText(tf(v), L - 6, y); }
  g.stroke();
  g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.fillText(`Z′ (${unit()})`, L + pw / 2, H - 8);
  g.save(); g.translate(16, T + ph / 2); g.rotate(-Math.PI / 2); g.fillText(`−Z″ (${unit()})`, 0, 0); g.restore();
  g.save(); g.beginPath(); g.rect(L, T, pw, ph); g.clip();
  g.strokeStyle = '#e3e6ea'; g.beginPath(); g.moveTo(L, Math.round(Y(0)) + .5); g.lineTo(L + pw, Math.round(Y(0)) + .5); g.stroke();
  if (fit) {
    const o = fit.model, fs = []; const f0 = Math.log(s.f[0] * 30), f1 = Math.log(s.f[s.f.length - 1] / 30); for (let i = 0; i <= 300; i++) fs.push(Math.exp(f0 + (f1 - f0) * i / 300));
    let x0 = o.R0;                                 // each semicircle drawn on its own, starting where the previous one ends
    o.arcs.forEach((a, i) => { const c = ARC_COL[Math.min(i, 2)]; g.beginPath(); g.moveTo(X(x0 * k), Y(0));
      for (const f of fs) { const z = zarc(a.R, a.tau, a.a, TWO_PI * f); g.lineTo(X((x0 + z[0]) * k), Y(-z[1] * k)); }
      g.lineTo(X((x0 + a.R) * k), Y(0)); g.closePath(); g.fillStyle = c + '47'; g.fill(); g.strokeStyle = c; g.lineWidth = 1; g.stroke(); x0 += a.R; });
    g.strokeStyle = '#111'; g.lineWidth = 1.7; g.beginPath();                    // total fit over the measured range
    const m0 = Math.log(s.f[fit.nSkip || 0]), m1 = Math.log(s.f[s.f.length - 1]); for (let i = 0; i <= 400; i++) { const z = zModel(o, Math.exp(m0 + (m1 - m0) * i / 400)); i ? g.lineTo(X(z[0] * k), Y(-z[1] * k)) : g.moveTo(X(z[0] * k), Y(-z[1] * k)); } g.stroke();
  }
  g.lineWidth = 1.1; g.fillStyle = '#fff';                                        // data; the inductive points left out of the fit are lighter
  for (let i = 0; i < s.f.length; i++) { g.strokeStyle = fit && i < (fit.nSkip || 0) ? '#c5cbd3' : '#6b7480'; g.beginPath(); g.arc(X(s.zr[i] * k), Y(-s.zi[i] * k), 3, 0, 7); g.fill(); g.stroke(); }
  if (fit) {                                       // what is reported: R_HFI (point on the axis) and R_ct (span of the later semicircles)
    const o = fit.model, a = (o.R0 + o.arcs[0].R) * k, b = (o.R0 + o.arcs.reduce((t, q) => t + q.R, 0)) * k, yb = Y(0) + 0.5;
    g.font = '600 11.5px -apple-system, "Segoe UI", sans-serif'; g.fillStyle = '#111'; g.beginPath(); g.arc(X(o.R0 * k), yb, 4, 0, 7); g.fill();
    g.strokeStyle = '#111'; g.lineWidth = 1.6; g.beginPath(); g.moveTo(X(a), yb - 5); g.lineTo(X(a), yb + 5); g.moveTo(X(b), yb - 5); g.lineTo(X(b), yb + 5); g.moveTo(X(a), yb); g.lineTo(X(b), yb); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'top'; const t1 = `R_HFI ${fmt(o.R0 * k)}`, t2 = `R_ct ${fmt(fit.R_ct * k)}`, hw = g.measureText(t1).width / 2, rw = g.measureText(t2).width / 2;
    const hx = Math.max(L + 4 + hw, X(o.R0 * k)), rx = Math.max((X(a) + X(b)) / 2, hx + hw + rw + 12);
    g.fillText(t1, hx, yb + 9); g.fillText(t2, rx, yb + 9);
  }
  g.restore();
}

// ---------------- page layout ----------------
function build() {
  const tb = $('.toolbar[data-pane=eis]'), sec = $('section[data-pane=eis]'); if (!tb || !sec) return;
  tb.innerHTML = `
    <label class="rdrop" id="e_drop" title="Drop the impedance files of one cell here, or click to choose several">
      <input type="file" id="e_file" multiple accept=".txt,.csv,.dat,.mpt,.dta,.z,.tsv" hidden>
      <span class="ic">⇣</span><span><b>Drop EIS files here</b><br><u>or click to choose files…</u></span></label>
    <label title="The same model is used for every spectrum of the set">model <select id="e_mode"><option value="3">3 semicircles</option><option value="2">2 semicircles</option></select></label>
    <label>electrode area <input type="number" id="e_area" min="0" step="any" style="width:70px" placeholder="—"> cm²</label>
    <label title="Two identical electrodes: values are divided by two"><input type="checkbox" id="e_sym"> symmetric cell (÷ 2)</label>
    <label title="Off: all points are fitted, with an inductor in the model. On: the points with −Z″ &lt; 0 at the high-frequency end are not used (drawn in light grey) and the model has no inductor. Applies to the whole set."><input type="checkbox" id="e_skipl" checked> leave out inductive points</label>
    <span class="sp"></span>
    <button type="button" id="e_clear">Clear</button>
    <button type="button" id="e_export" class="primary" title="Excel file: sheet Results with R_HFI and R_ct of every spectrum, then one sheet for each spectrum with the measured points and the fitted curve">Export results</button>`;
  sec.innerHTML = `
    <div id="e_msg" style="padding:6px 16px 0;font-size:13px;color:var(--muted);min-height:6px"></div>
    <div id="e_warn" hidden style="margin:6px 16px 0;padding:7px 12px;border:1px solid #f0d9a0;background:#fff6e0;border-radius:7px;font-size:13px"></div>
    <div id="e_cite" style="margin:6px 16px 0;padding:7px 12px;border:1px solid #e3a5a5;background:#fdf1f1;border-radius:7px;font-size:13px;color:#b00000;font-weight:600"><div><b>${doiLinks(CITE[0]).replace(':', ':</b>')} · <a href="https://github.com/DAL-CYang-Group/cellpeek-eis" target="_blank" rel="noopener">source code on GitHub</a> · <a href="https://github.com/DAL-CYang-Group/cellpeek-eis#readme" target="_blank" rel="noopener">README</a></div><div style="margin-top:2px">Please also cite — ${doiLinks(CITE[1])}</div></div>
    <div class="egrid">
      <div id="e_plots"></div>
      <div class="mod" id="e_res">
        <div class="bar"><span class="t">Results</span><span class="opts gmuted" id="e_sum"></span></div>
        <div id="e_tab"></div>
        <div class="note">R_HFI: high-frequency intercept with the Z′ axis. R_ct: summed diameters of the semicircle(s) after the first one. The first, highest-frequency semicircle (grey, contact) is not included. Width: contact + R_ct, the whole span of the semicircles. Inductive points at the high-frequency end (−Z″ &lt; 0) are fitted with an inductor, or left out (light grey) when that box is ticked. The tail is detected for each spectrum.</div>
      </div>
    </div>`;
  $('#e_file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
  const dz = $('#e_drop');
  for (const el of [dz, sec]) {
    el.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
    el.addEventListener('dragleave', () => dz.classList.remove('over'));
    el.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles([...e.dataTransfer.files]); });
  }
  $('#e_mode').onchange = e => { S.mode = +e.target.value; refitAll(); };
  $('#e_area').oninput = e => { S.area = e.target.value; render(); };
  $('#e_sym').onchange = e => { S.sym = e.target.checked; render(); };
  $('#e_skipl').onchange = e => { S.skipL = e.target.checked; if (NQP.log) NQP.log('eis_inductive', {skip: S.skipL}); refitAll(); };
  $('#e_clear').onclick = () => { S.spectra = []; S.mode = 3; msg(''); render(); };
  $('#e_export').onclick = exportCsv;
  let rt; new ResizeObserver(() => { if (sec.hidden) return; clearTimeout(rt); rt = setTimeout(drawAll, 80); }).observe(sec);
}
const headHtml = s => { const k = scale(), u = unit(), f = good(s), poor = f && f.err > POOR;
  return `<span class="t" title="${esc(s.name)}"><bdi>${esc(s.name)}</bdi></span>
    <span class="opts">${!s.fit ? 'fitting…' : !f ? '<b style="color:#b00">could not be fitted</b>' : `R_HFI <b>${fmt(f.R_HFI * k)}</b> · R_ct <b>${fmt(f.R_ct * k)}</b> · width <b>${fmt((f.R_contact + f.R_ct) * k)}</b> ${u} · ${f.tail ? 'tail' : 'no tail'} · <span style="${poor ? 'color:#b00;font-weight:600' : ''}">error ${f.err.toFixed(2)} %</span>`}</span>
    <button type="button" class="expbtn" data-copy="${s.id}" title="Copy the picture to the clipboard">Copy</button><button type="button" class="expbtn" data-png="${s.id}">PNG</button>`; };
function drawAll() { const rg = commonRange(); for (const s of S.spectra) { const cv = $('#cv_' + s.id); if (cv) drawNyq(cv, s, rg); } }
function renderRow(s) {                           // after one fit: its card, the table and the banner (the common axes may have moved)
  const c = $('#card_' + s.id); if (c) { $('.bar', c).innerHTML = headHtml(s); hookCard(c, s); }
  renderTable(); drawAll();
}
function hookCard(c, s) {
  const pic = () => { const cv = $('#cv_' + s.id), rg = commonRange();
    EXPORTING = true; try { drawNyq(cv, s, rg); } finally { EXPORTING = false; }
    const c2 = fitWidth(cv, 0, cv.width, cv.width); drawNyq(cv, s, rg); return c2; };
  const save = () => putPic(pic(), 'eis_' + s.name + '.png', null), copy = () => putPic(pic(), '', k);
  const b = $('[data-png]', c); if (b) b.onclick = save;
  const k = $('[data-copy]', c); if (k) k.onclick = copy; }
function renderTable() {
  const k = scale(), u = unit();
  const rows = S.spectra.map(q => { const t = good(q), poor = t && t.err > POOR;
    return `<tr data-id="${q.id}" style="cursor:pointer"><td style="max-width:230px;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left" title="${esc(q.name)}"><bdi>${esc(q.name)}</bdi></td>
      <td style="text-align:right"><b>${t ? fmt(t.R_HFI * k) : q.fit ? 'failed' : '…'}</b></td><td style="text-align:right">${t ? fmt(t.R_contact * k) : ''}</td><td style="text-align:right"><b>${t ? fmt(t.R_ct * k) : ''}</b></td><td style="text-align:right">${t ? fmt((t.R_contact + t.R_ct) * k) : ''}</td>
      <td>${t ? (t.tail ? 'yes' : 'no') : ''}</td>
      <td style="text-align:right;${poor ? 'color:#b00;font-weight:600' : 'color:var(--muted)'}">${t ? t.err.toFixed(2) : ''}</td>
      <td class="x" title="Remove">✕</td></tr>`; }).join('');
  $('#e_tab').innerHTML = S.spectra.length ? `<table class="pk"><thead><tr><th>Spectrum</th><th style="text-align:right">R_HFI<br>(${u})</th><th style="text-align:right" title="Diameter of the first, highest-frequency semicircle (contact); not part of R_ct">R_contact<br>(${u})</th><th style="text-align:right">R_ct<br>(${u})</th><th style="text-align:right" title="Total width of the semicircles: contact + R_ct. This sum is steadier than its two parts when the semicircles overlap">width<br>(${u})</th><th>tail</th>
      <th style="text-align:right" title="Root-mean-square relative deviation between fit and data, over the points with −Z″ ≥ 0 (the inductive high-frequency points are fitted but not counted here)">error<br>(%)</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="gmuted" style="padding:8px 2px">No spectra yet.</div>';
  $('#e_tab').querySelectorAll('tr[data-id]').forEach(tr => { const q = S.spectra.find(z => z.id === tr.dataset.id);
    tr.onclick = e => { if (e.target.classList.contains('x')) { S.spectra = S.spectra.filter(z => z !== q); render(); } else { const c = $('#card_' + q.id); if (c) c.scrollIntoView({behavior: 'smooth', block: 'center'}); } }; });
  const done = S.spectra.filter(good), poor = done.filter(q => q.fit.err > POOR), failed = S.spectra.filter(q => q.fit && q.fit.failed);
  $('#e_sum').textContent = S.spectra.length ? `${S.mode} semicircles · ${S.skipL ? 'inductive points left out · ' : ''}${done.length} / ${S.spectra.length} fitted` : '';
  const w = $('#e_warn'), n = poor.length + failed.length, all = S.spectra.every(q => q.fit);
  if (n && all) { w.hidden = false;
    w.innerHTML = S.mode === 2 ? `<b>${n} of ${S.spectra.length} spectra fit poorly with 2 semicircles</b> (marked red). The whole set should then use 3 semicircles. <button type="button" id="e_to3" class="primary" style="margin-left:8px;padding:3px 12px">Use 3 semicircles for all</button>`
      : `<b>${n} of ${S.spectra.length} spectra still fit poorly with 3 semicircles</b> (marked red): look at those plots.`;
    const b = $('#e_to3'); if (b) b.onclick = () => { S.mode = 3; $('#e_mode').value = '3'; refitAll(); };
  } else w.hidden = true;
}
function render() {
  save();
  const sec = $('section[data-pane=eis]'); if (!sec || sec.hidden) return;
  $('#e_mode').value = String(S.mode);
  const box = $('#e_plots');
  box.innerHTML = S.spectra.length ? S.spectra.map(s => `<div class="mod" id="card_${s.id}"><div class="bar">${headHtml(s)}</div><div class="plot"><canvas id="cv_${s.id}"></canvas></div></div>`).join('')
    : '<div class="mod"><div class="note" style="padding:14px 4px">Drop the impedance files of one cell (frequency, Z′, Z″) on the box above. They are listed here one below the other and fitted as soon as they are loaded, all with the same model.</div></div>';
  for (const s of S.spectra) hookCard($('#card_' + s.id), s);
  renderTable(); drawAll();
}
// ---------------- export: one .xlsx, written here without a library ----------------
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function zipStore(files) {                        // files: [[name, text]], stored without compression
  const enc = new TextEncoder(), parts = [], cen = []; let off = 0;
  const hdr = (sig, n) => { const v = new DataView(new ArrayBuffer(n)); v.setUint32(0, sig, true); return v; };
  for (const [name, text] of files) { const nm = enc.encode(name), data = enc.encode(text), crc = crc32(data);
    const l = hdr(0x04034b50, 30); l.setUint16(4, 20, true); l.setUint16(6, 0x0800, true); l.setUint16(12, 0x21, true); l.setUint32(14, crc, true); l.setUint32(18, data.length, true); l.setUint32(22, data.length, true); l.setUint16(26, nm.length, true);
    const c = hdr(0x02014b50, 46); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    parts.push(l, nm, data); cen.push(c, nm); off += 30 + nm.length + data.length; }
  const csize = cen.reduce((a, x) => a + x.byteLength, 0), e = hdr(0x06054b50, 22);
  e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, e], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
const colName = i => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
const xmlEsc = t => String(t).replace(/[&<>]/g, ch => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[ch])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
function sheetXml(rows, widths) {                 // a cell: number, text, or '' / null / undefined for an empty cell
  const body = rows.map((r, i) => `<row r="${i + 1}">` + r.map((c, j) => c === '' || c == null ? '' : typeof c === 'number' && isFinite(c) ? `<c r="${colName(j)}${i + 1}"><v>${c}</v></c>`
    : `<c r="${colName(j)}${i + 1}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(c)}</t></is></c>`).join('') + '</row>').join('');
  const cols = widths ? '<cols>' + widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('') + '</cols>' : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
}
function xlsx(sheets) {                           // sheets: [{name, rows, widths}]
  const X = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', P = 'http://schemas.openxmlformats.org/', R = P + 'officeDocument/2006/relationships';
  return zipStore([
    ['[Content_Types].xml', `${X}<Types xmlns="${P}package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `${X}<Relationships xmlns="${P}package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${X}<workbook xmlns="${P}spreadsheetml/2006/main" xmlns:r="${R}"><sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name).replace(/"/g, '&quot;')}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${X}<Relationships xmlns="${P}package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`],
    ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s.rows, s.widths)])]);
}
NQP.xlsx = xlsx;                                  // index.html: Export Excel of the cycling plots
function exportBook() {
  const k = scale(), u = unit().replace('Ω', 'ohm').replace('²', '2'), n6 = v => +(+v).toPrecision(6);
  const res = [['spectrum', `R_HFI (${u})`, `R_ct (${u})`, `semicircle width = R_contact + R_ct (${u})`, `R_contact (${u})`, 'semicircles', 'diffusion tail', 'fit error (%), points with -Z\'\' >= 0', 'fit error (%), all points', 'inductive points']];
  for (const q of S.spectra) { const t = good(q); res.push([q.name, t ? n6(t.R_HFI * k) : '', t ? n6(t.R_ct * k) : '', t ? n6((t.R_contact + t.R_ct) * k) : '', t ? n6(t.R_contact * k) : '', S.mode, t ? (t.tail ? 'yes' : 'no') : '', t ? +t.err.toFixed(2) : 'failed', t && t.errAll != null ? +t.errAll.toFixed(2) : '', t ? (t.nSkip ? `${t.nSkip} left out` : t.L ? 'fitted with an inductor' : 'none') : '']); }
  res.push([]); for (const c of CITE) res.push([c]);
  // one sheet for each spectrum: measured points and the fit at the same frequencies. Inductive points that were left out of the fit are not listed.
  const used = new Set(['results']), sheets = [{name: 'Results', rows: res, widths: [34, 12, 12, 16, 14, 12, 12, 14, 14, 22]}];
  const sheetName = (nm, n) => {                  // Excel: at most 31 characters, none of [ ] : * ? / \, no ' at either end, no two alike
    const base = String(nm).replace(/[\[\]:*?\/\\]/g, '_').replace(/^'+|'+$/g, '').trim() || 'spectrum ' + n; let s = base.slice(-31);        // the end of a name is what tells the spectra of a series apart
    for (let k = 2; used.has(s.toLowerCase()); k++) { const t = ' (' + k + ')'; s = base.slice(-(31 - t.length)) + t; }
    used.add(s.toLowerCase()); return s; };
  S.spectra.forEach((q, b) => { const t = good(q), i0 = t ? t.nSkip || 0 : 0, rows = [[q.name], ['f (Hz)', `Z' (${u})`, `-Z'' (${u})`, `fit Z' (${u})`, `fit -Z'' (${u})`]];
    for (let i = i0; i < q.f.length; i++) { const z = t ? zModel(t.model, q.f[i]) : null; rows.push([q.f[i], n6(q.zr[i] * k), n6(-q.zi[i] * k), z ? n6(z[0] * k) : '', z ? n6(-z[1] * k) : '']); }
    sheets.push({name: sheetName(q.name, b + 1), rows, widths: [14, 14, 14, 14, 14]}); });
  return xlsx(sheets);
}
function exportCsv() {                            // name kept; the file is an Excel workbook: sheet Results and one sheet for each spectrum
  if (!S.spectra.length) return msg('Nothing to export');
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const a = document.createElement('a'); a.href = URL.createObjectURL(exportBook()); a.download = `${stamp}_EIS_RHFI_Rct.xlsx`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  if (NQP.log) NQP.log('eis_export', {n: S.spectra.length});
}
if (typeof window !== 'undefined') window.NQP_eisBook = exportBook;      // for checking the file from the console

// the set (spectra, fits, model, area) is kept in this browser and comes back when the page is opened again
let saveT = null, ready = false;
function save() {
  if (!ready || !NQP.idb) return;
  clearTimeout(saveT); saveT = setTimeout(() => { NQP.idb.set('eis', {spectra: S.spectra, mode: S.mode, area: S.area, sym: S.sym, skipL: S.skipL, dv: 2, seq, fv: FITV}).catch(() => {}); }, 600);
}
async function restore() {
  try { const r = NQP.idb && await NQP.idb.get('eis');
    if (r && Array.isArray(r.spectra)) { Object.assign(S, {spectra: r.spectra, mode: r.fv !== FITV ? 3 : r.mode === 2 ? 2 : 3, area: r.area || '', sym: !!r.sym, skipL: r.dv === 2 ? !!r.skipL : true});     // dv 2: saved after leaving out the inductive points became the default seq = r.seq || r.spectra.length;      // sets saved with an older fitting method start again with the default model
      for (const q of S.spectra) if (q.fit && (q.fit.v !== FITV || (r.dv !== 2 && !r.skipL))) q.fit = null;        // fitted with an older method: fit again
      if ($('#e_area')) { $('#e_area').value = S.area; $('#e_sym').checked = S.sym; $('#e_skipl').checked = S.skipL; } } } catch {}
  ready = true;
}
window.addEventListener('DOMContentLoaded', async () => { build(); await restore(); render(); fitQueue(S.spectra.filter(s => !s.fit)); window.addEventListener('cellpeek:tab', () => render()); });
NQP.eis = {addText: (name, text) => addFiles([new File([text], name)]), state: () => S, ...API};
})();
