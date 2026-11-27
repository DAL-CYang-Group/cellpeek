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
  if ([dV, dQ, sType, sQ, cIdx].includes(null)) {
    const miss = [[cIdx, 'cycle number'], [sType, 'step type'], [sQ, 'step capacity (mAh/g)'], [dV, 'voltage'], [dQ, 'data capacity (mAh/g)']].filter(x => x[0] === null).map(x => x[1]);
    throw new Error(`this export format is not known yet (parser ${PARSER_VERSION}): no column for ${miss.join(', ')}. Step columns: ${H_s.slice(0, 7).join(', ')}. Data columns: ${H_d.slice(0, 7).join(', ')}`);
  }
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

// ---------------- Maccor ----------------
// A Maccor export is one table: a line with the test date, file name and procedure, then the column names
// (Rec#, Cyc#, Step, TestTime, StepTime, mAmp-hr, Watt-hr, mAmps, Volts; some exports add State), then one row per record.
// It comes as text (tabs or commas) or as that table saved from Excel (.xlsx, also when the name ends with .xls).
// Differences from Neware, and what is done about them:
//   * capacity is in mAh only (no mass in the file): the result is marked nomass, and mAh/g holds the same numbers as mAh;
//   * the current is often written without a sign and Cyc# can stay 0 (formation): charge or discharge is taken from the State
//     column or the sign of the current if there is one, else from the voltage going up or down in the step (a step at constant
//     voltage belongs to the step before it); a new cycle starts with the first charge after a discharge;
//   * capacity and energy start again at 0 in every step, as in Neware.
async function inflate(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()); }
async function unzip(buf, want) {                 // the files of a zip whose name passes want(): Map name -> text
  const b = new Uint8Array(buf), dv = new DataView(buf), out = new Map(), td = new TextDecoder();
  let e = b.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('this Excel file cannot be read (not a complete .xlsx)');
  let p = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true);
  for (let i = 0; i < n && dv.getUint32(p, true) === 0x02014b50; i++) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const name = td.decode(b.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    if (!want(name)) continue;
    const s = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true), raw = b.subarray(s, s + csize);
    out.set(name, td.decode(method === 8 ? await inflate(raw) : raw));
  }
  return out;
}
const unx = s => s.indexOf('&') < 0 ? s : s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  e = e.toLowerCase(); return e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)); });
async function xlsxRows(buf) {                    // first sheet of an .xlsx -> rows of cell values (text; numbers as written)
  const f = await unzip(buf, n => /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(n));
  const sheets = [...f.keys()].filter(n => /sheet\d+\.xml$/.test(n)).sort((a, b) => a.match(/\d+/)[0] - b.match(/\d+/)[0]);
  if (!sheets.length) throw new Error('this Excel file has no sheet');
  const tx = s => { let t = ''; for (const x of s.matchAll(/<t(?:\s[^>]*[^\/>])?>([\s\S]*?)<\/t>/g)) t += x[1]; return unx(t); };
  const ss = []; for (const m of (f.get('xl/sharedStrings.xml') || '').matchAll(/<si\/>|<si>([\s\S]*?)<\/si>/g)) ss.push(m[1] ? tx(m[1]) : '');
  const col = s => { let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + s.charCodeAt(i) - 64; return n - 1; }, rows = [];
  for (const r of f.get(sheets[0]).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const a = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] || '', t = (c[2].match(/\bt="(\w+)"/) || [])[1], v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      a[col(c[1])] = t === 'inlineStr' ? tx(body) : v == null ? '' : t === 's' ? (ss[+v] || '') : unx(v);
    }
    rows.push(a);
  }
  return rows;
}
function textRows(txt) {
  const lines = txt.split(/\r\n|\r|\n/), tabs = lines.slice(0, 5).some(l => l.includes('\t'));
  return lines.filter(l => l.trim()).map(l => l.split(tabs ? '\t' : ','));
}
function parseMaccor(rows) {
  const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9#]/g, '');
  let h = -1; for (let i = 0; i < Math.min(rows.length, 40); i++) { const n = Array.from(rows[i], norm); if (n.includes('step') && (n.includes('rec#') || n.includes('cyc#'))) { h = i; break; } }
  if (h < 0) throw new Error('not a Maccor export: no line with the column names (Rec#, Cyc#, Step, ...)');
  const H = Array.from(rows[h], norm), col = (...names) => { for (const n of names) { const i = H.indexOf(n); if (i >= 0) return i; } return -1; };
  const cStep = col('step'), cCyc = col('cyc#', 'cycle'), cT = col('testtime', 'testtimes', 'testtimesec', 'testsec', 'testtimehr', 'testtimemin'),
    cQ = col('mamphr', 'amphr', 'capacitymah', 'capacityah', 'capacity'), cE = col('watthr', 'mwatthr', 'energywh', 'energy'), cI = col('mamps', 'amps', 'currentma', 'currenta', 'current'),
    cV = col('volts', 'voltage', 'voltagev'), cS = col('state', 'md');
  const miss = [[cQ, 'capacity (mAmp-hr)'], [cV, 'voltage (Volts)']].filter(x => x[0] < 0).map(x => x[1]);
  if (miss.length) throw new Error('Maccor export: no column for ' + miss.join(', ') + '. Columns: ' + H.filter(x => x).slice(0, 12).join(', '));
  const qS = /^(amphr|capacityah)$/.test(H[cQ]) ? 1000 : 1, eS = cE >= 0 && H[cE] === 'mwatthr' ? 1 : 1000, tName = cT >= 0 ? H[cT] : '';
  const hours = x => {                              // "  2d 19:08:39.92", "19:08:39", or a number (seconds if the column says so; from Excel: days)
    if (x == null || x === '') return null; const s = String(x).trim(); let m;
    if ((m = s.match(/^(?:(\d+)\s*d\s*)?(\d+):(\d+):([\d.]+)$/))) return (+(m[1] || 0)) * 24 + (+m[2]) + (+m[3]) / 60 + (+m[4]) / 3600;
    const v = Number(s); if (!Number.isFinite(v)) return null;
    return /sec|s$/.test(tName) ? v / 3600 : /min/.test(tName) ? v / 60 : /hr/.test(tName) ? v : v * 24;
  };
  // steps: one segment per (cycle, step) run
  const segs = []; let seg = null, iAll = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const a = rows[i], v = num(a[cV]), q = num(a[cQ]); if (v === null || q === null) continue;
    const key = (cCyc >= 0 ? a[cCyc] : '') + '|' + a[cStep];
    if (!seg || seg.key !== key) segs.push(seg = {key, q: [], v: [], e: 0, t: null, imin: 0, imax: 0, st: ''});
    seg.q.push(Math.abs(q) * qS); seg.v.push(v);
    if (cE >= 0) seg.e = Math.abs(num(a[cE]) || 0) * eS;
    if (cI >= 0) { const c = num(a[cI]) || 0; if (c < seg.imin) seg.imin = c; if (c > seg.imax) seg.imax = c; iAll = Math.max(iAll, Math.abs(c)); }
    if (cT >= 0) { const t = hours(a[cT]); if (t !== null) seg.t = t; }
    if (cS >= 0 && !seg.st) { const s = String(a[cS] || '').trim().toUpperCase(); if (s === 'C' || s === 'D') seg.st = s; }
  }
  if (!segs.length) throw new Error('Maccor export: no data rows');
  const signed = segs.some(s => s.imin < -1e-3 * iAll), hasSt = segs.some(s => s.st);
  let prev = null, k = 1, disSeen = false;
  const agg = new Map(), vq = new Map(), A = c => { let a = agg.get(c); if (!a) { a = {}; agg.set(c, a); } return a; };
  for (const s of segs) {
    const n = s.q.length, qEnd = s.q[n - 1]; let dir = null;
    const rest = cI >= 0 ? Math.max(-s.imin, s.imax) <= 1e-3 * iAll : !(qEnd > 0);
    if (!rest) {
      if (hasSt) dir = s.st === 'C' ? 'chg' : s.st === 'D' ? 'dis' : null;
      else if (signed) dir = s.imax + s.imin >= 0 ? 'chg' : 'dis';
      else { const dV = s.v[n - 1] - s.v[0]; dir = Math.abs(dV) >= 0.005 ? (dV > 0 ? 'chg' : 'dis') : (prev || 'chg'); }
    }
    if (!dir) continue;
    if (dir === 'chg' && disSeen) { k++; disSeen = false; }
    if (dir === 'dis') disSeen = true;
    prev = dir;
    const a = A(k), [k1, k2] = dir === 'chg' ? ['qc', 'ec'] : ['qd', 'ed'];
    a[k1] = (a[k1] || 0) + qEnd; a[k2] = (a[k2] || 0) + s.e; if (s.t !== null) a['t_' + dir] = s.t;
    let e = vq.get(k); if (!e) { e = {}; vq.set(k, e); }
    const d = e[dir] || (e[dir] = [[], []]); for (let j = 0; j < n; j++) { d[0].push(s.q[j]); d[1].push(s.v[j]); }
  }
  const cycles = [];
  for (const c of [...agg.keys()].sort((a, b) => a - b)) {
    const a = agg.get(c), qc = a.qc || 0, qd = a.qd || 0; if (qc <= 0 && qd <= 0) continue;
    const vc = qc > 0 && a.ec ? a.ec / qc : null, vd = qd > 0 && a.ed ? a.ed / qd : null, t = a.t_dis != null ? a.t_dis : a.t_chg;
    cycles.push({k: c, qc: round(qc, 5), qd: round(qd, 5), qc_mAh: round(qc, 5), qd_mAh: round(qd, 5), ce: qc > 0 && qd > 0 ? round(100 * qd / qc, 3) : null,
      vc: vc ? round(vc, 5) : null, vd: vd ? round(vd, 5) : null, dv: vc && vd ? round(vc - vd, 5) : null, t_h: t != null ? round(t, 4) : null});
  }
  while (cycles.length && cycles[cycles.length - 1].qd <= 0) cycles.pop();      // the cycle still running (or a last charge to a state of charge) is not a point; its V-Q curve is kept
  const vqOut = {}; for (const [c, d] of vq) { const e = {}; if (d.chg) e.chg = d.chg; if (d.dis) e.dis_raw = d.dis; vqOut[c] = e; }
  let start = null;                                // "Date of Test:" in the lines above the column names
  for (const r of rows.slice(0, h)) for (let i = 0; i < r.length - 1; i++) if (/dateoftest/.test(norm(r[i]))) {
    const x = r[i + 1], v = Number(x); let d = null, utc = false;
    if (x !== '' && Number.isFinite(v) && v > 20000 && v < 80000) { d = new Date(Math.round((v - 25569) * 86400000)); utc = true; }   // Excel day number
    else { const p = new Date(String(x)); if (!isNaN(p)) d = p; }
    if (d) start = utc ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
      : `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  return {fmt: 'maccor', offset: 0, start, cycles, vq: vqOut, nomass: true};
}
// any file dropped on the page: Maccor (Excel or text) or a Neware export
async function parseFile(buf) {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  if (b[0] === 0x50 && b[1] === 0x4B) return parseMaccor(await xlsxRows(buf));
  if (b[0] === 0xD0 && b[1] === 0xCF) throw new Error('old Excel format (binary .xls): open it in Excel, save it as .xlsx and drop that file');
  const u16 = (b[0] === 0xFF && b[1] === 0xFE) || (b[0] === 0xFE && b[1] === 0xFF);
  const head = new TextDecoder(u16 ? (b[0] === 0xFF ? 'utf-16le' : 'utf-16be') : 'utf-8').decode(buf.slice(0, 6000));
  if (/Rec#|Cyc#/.test(head)) return parseMaccor(textRows(new TextDecoder(u16 ? (b[0] === 0xFF ? 'utf-16le' : 'utf-16be') : 'utf-8').decode(buf)));
  return parseNeware(buf);
}

if (typeof module !== 'undefined') module.exports = {parseNeware, parseMaccor, parseFile, xlsxRows, textRows, vqFor, PARSER_VERSION};
else if (typeof self !== 'undefined' && typeof window === 'undefined') {     // Web Worker: {id, file} -> {id, data} | {id, error}
  self.onmessage = async (ev) => {
    const {id, file} = ev.data;
    try { const t0 = Date.now(), data = await parseFile(await file.arrayBuffer()); data.parse_s = round((Date.now() - t0) / 1000, 2); self.postMessage({id, data}); }
    catch (e) { self.postMessage({id, error: e.message || String(e)}); }
  };
}
