// Neware export parser (JavaScript port of server.py parse_neware, PARSER_VERSION 6).
// Runs in a Web Worker in the browser, and under Node for testing. Read-only: it only receives file bytes.
// Handles the old and new Neware exports (UTF-16; cycle / step / data levels with 0 / 3 / 6 leading tabs),
// the oldest BTS export (UTF-8; 0 / 1 / 2 leading tabs; Cycle ID, Cap(mAh), CmpCap(mAh/g), Vol(mV), Realtime),
// and the 2022 BTS export (single-byte text; 0 / 3 / 6 leading tabs; Cycle ID, Step Name, Capacity Density(mAh/g), CmpEngergy(mWh/g), Realtime;
// columns padded with a varying number of tabs, and data rows leave the Min/Max/Avg temperature columns empty).
'use strict';
const PARSER_VERSION = 6;

function decodeNeware(buf) {
  const b = new Uint8Array(buf);
  let enc = 'utf-16le', skip = 0;
  if (b[0] === 0xFF && b[1] === 0xFE) { skip = 2; }
  else if (b[0] === 0xFE && b[1] === 0xFF) { enc = 'utf-16be'; skip = 2; }
  let txt = new TextDecoder(enc).decode(b.subarray(skip));
  let tabs = 0; for (let i = 0; i < txt.length && tabs < 200; i++) if (txt.charCodeAt(i) === 9) tabs++;
  if (tabs < 200) txt = new TextDecoder('utf-8').decode(b);
  return txt;
}

function num(s) {
  if (s == null) return null; s = String(s).trim(); if (s === '') return null;
  const v = Number(s); return Number.isFinite(v) ? v : null;
}

function parseDate(s) {          // local time, like Python's datetime.strptime(...).timestamp(); returns seconds
  s = String(s || '').trim(); let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/)))
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(+('0.' + m[7]) * 1000) : 0).getTime() / 1000;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2})$/)))
    return new Date(+m[3], +m[1] - 1, +m[2], +m[4], +m[5], +m[6]).getTime() / 1000;
  return null;
}

const round = (x, d) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
const lead = ln => { let i = 0; while (ln.charCodeAt(i) === 9) i++; return i; };
const fieldsRaw = ln => ln.split('\t').filter(x => x.trim());
const fieldsStrip = ln => ln.split('\t').map(x => x.trim()).filter(x => x);
const pad2 = n => String(n).padStart(2, '0');

function parseNeware(buf) {
  const txt = decodeNeware(buf);
  const lines = txt.split(/\r\n|\r|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length < 4) throw new Error('file too short (probably an empty stub)');
  const hdr = {};
  for (const ln of lines.slice(0, 3)) hdr[lead(ln)] = fieldsStrip(ln);
  const lv = Object.keys(hdr).map(Number).sort((a, b) => a - b);
  if (lv.length !== 3) throw new Error('unrecognized format (header is not three-level)');
  const [L_c, L_s, L_d] = lv, H_c = hdr[L_c], H_s = hdr[L_s], H_d = hdr[L_d];
  const col = (H, ...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return null; };

  const dV = col(H_d, 'Voltage(V)', 'Voltage(mV)', 'Vol(mV)'), dQ = col(H_d, 'Spec. Cap.(mAh/g)', 'CmpCap(mAh/g)', 'Capacity Density(mAh/g)');
  const dDate = col(H_d, 'Date', 'Realtime', 'Real Time');
  const sType = col(H_s, 'Step Type', 'Step Name'), sQ = col(H_s, 'Spec. Cap.(mAh/g)', 'CmpCap(mAh/g)', 'Capacity Density(mAh/g)'), sE = col(H_s, 'Spec. Energy(mWh/g)', 'CmpEng(mWh/g)', 'CmpEngergy(mWh/g)', 'CmpEnergy(mWh/g)');
  const sCap = col(H_s, 'Capacity(Ah)', 'Capacity(mAh)', 'Cap(mAh)'), capscale = H_s.includes('Capacity(Ah)') ? 1000 : 1;
  const cIdx = col(H_c, 'Cycle Index', 'Cycle ID');
  if ([dV, dQ, sType, sQ, cIdx].includes(null)) throw new Error('required columns missing: ' + H_d.slice(0, 6).join(', '));
  const vscale = H_d[dV] === 'Voltage(V)' ? 1 : 1e-3;
  const nC = H_c.length, nS = H_s.length, nD = H_d.length;
  // 2022 BTS export: data rows have empty cells after Realtime, so they hold fewer values than the header; the columns used here come before those
  const bts22 = H_d.includes('Capacity Density(mAh/g)'), needD = Math.max(dV, dQ, dDate === null ? 0 : dDate) + 1;

  let cyc = null, stype = null, cur = null, firstDate = null, lastDateStr = null;
  const agg = new Map(), vq = new Map();
  const A = k => { let a = agg.get(k); if (!a) { a = {}; agg.set(k, a); } return a; };
  const closeStep = () => {
    if (cur && lastDateStr && dDate !== null) { const t = parseDate(lastDateStr); if (t !== null) A(cur[0])['t_' + cur[1]] = t; }
  };
  for (let i = 3; i < lines.length; i++) {
    const ln = lines[i], L = lead(ln);
    if (L === L_d) {
      if (cyc === null) continue;
      const f = fieldsRaw(ln); if (f.length !== nD && !(bts22 && f.length >= needD && f.length < nD)) continue;
      if (firstDate === null && dDate !== null) firstDate = parseDate(f[dDate]);
      if (stype !== 'chg' && stype !== 'dis') continue;
      const v = num(f[dV]), q = num(f[dQ]); if (v === null || q === null) continue;
      let e = vq.get(cyc); if (!e) { e = {}; vq.set(cyc, e); }
      const d = e[stype] || (e[stype] = [[], []]); d[0].push(q); d[1].push(v * vscale);
      if (dDate !== null) lastDateStr = f[dDate];
    } else if (L === L_s) {
      const f = fieldsStrip(ln); if (f.length !== nS) continue;
      closeStep();
      const t = f[sType].toLowerCase().replace(/[ _]/g, '');
      stype = t.includes('dchg') ? 'dis' : (t.includes('chg') ? 'chg' : null);
      cur = stype ? [cyc, stype] : null;
      if (stype && cyc !== null) {
        const a = A(cyc), q = num(f[sQ]) || 0, e = sE !== null ? (num(f[sE]) || 0) : 0, cap = sCap !== null ? (num(f[sCap]) || 0) * capscale : 0;
        const [k1, k2, k3] = stype === 'chg' ? ['qc', 'ec', 'ac'] : ['qd', 'ed', 'ad'];
        a[k1] = (a[k1] || 0) + q; a[k2] = (a[k2] || 0) + e; a[k3] = (a[k3] || 0) + cap;
      }
      lastDateStr = null;
    } else if (L === L_c) {
      const f = fieldsStrip(ln); if (f.length !== nC) continue;
      closeStep(); cur = null; stype = null; lastDateStr = null;
      const c = num(f[cIdx]); if (c === null) continue; cyc = Math.trunc(c);
    }
  }
  closeStep();

  const off = ((agg.get(1) || {}).qd || 0) > 0 ? 0 : 1;      // cycle 1 charge-only -> discharge index shifted by 1
  const cycles = [];
  for (const k of [...agg.keys()].sort((a, b) => a - b)) {
    const a = agg.get(k), b = agg.get(k + off) || {};
    const qc = a.qc || 0, qd = b.qd || 0;
    if (qc <= 0 && qd <= 0) continue;
    const vc = qc > 0.5 && a.ec ? a.ec / qc : null, vd = qd > 0.5 && b.ed ? b.ed / qd : null;
    const t = b.t_dis || a.t_chg;
    cycles.push({k, qc: round(qc, 3), qd: round(qd, 3), qc_mAh: round(a.ac || 0, 5), qd_mAh: round(b.ad || 0, 5),
      ce: qc > 0.5 && qd > 0 ? round(100 * qd / qc, 3) : null,
      vc: vc ? round(vc, 5) : null, vd: vd ? round(vd, 5) : null, dv: vc && vd ? round(vc - vd, 5) : null,
      t_h: t && firstDate ? round((t - firstDate) / 3600, 4) : null});
  }
  while (cycles.length && (cycles[cycles.length - 1].qd <= 0 || (cycles[cycles.length - 1].ce || 0) < 80)) cycles.pop();
  const vqOut = {};                                     // discharge stored under its own index (dis_raw); paired with the offset on request
  for (const [k, d] of vq) { const e = {}; if (d.chg) e.chg = d.chg; if (d.dis) e.dis_raw = d.dis; vqOut[k] = e; }
  let start = null;
  if (firstDate) { const d = new Date(firstDate * 1000); start = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  return {fmt: bts22 ? 'bts22' : H_d.includes('Vol(mV)') ? 'bts' : (H_d.includes('Voltage(mV)') ? 'old' : 'new'), offset: off, start, cycles, vq: vqOut};
}

// pick V-Q curves for cycles ks, applying the offset (same as /api/vq)
function vqFor(data, ks) {
  const out = {}, off = data.offset;
  for (const k of ks) { const e = {}, c = (data.vq[k] || {}).chg, d = (data.vq[k + off] || {}).dis_raw;
    if (c) e.chg = c; if (d) e.dis = d; if (c || d) out[k] = e; }
  return out;
}

if (typeof module !== 'undefined') module.exports = {parseNeware, vqFor, PARSER_VERSION};
else if (typeof self !== 'undefined' && typeof window === 'undefined') {     // Web Worker: {id, file} -> {id, data} | {id, error}
  self.onmessage = async (ev) => {
    const {id, file} = ev.data;
    try { const t0 = Date.now(), data = parseNeware(await file.arrayBuffer()); data.parse_s = round((Date.now() - t0) / 1000, 2); self.postMessage({id, data}); }
    catch (e) { self.postMessage({id, error: e.message || String(e)}); }
  };
}
