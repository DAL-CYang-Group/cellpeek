/**
 * CellPeek — backend (Google Apps Script, bound to a Google Sheet).
 *
 * Sheet tabs (made by setup()): users, devices, log, feedback, config, stats.
 *   users   : one row per person. status = active | revoked.  super = TRUE lets them use the remote (Tailscale) server.
 *   devices : one row per computer/browser. status = unverified | pending | approved | denied | revoked | logged_out.
 *   config  : ADMIN_EMAIL, DAL_RANGES, LATEST_VERSION, NOTICE, APP_URL, FEEDBACK_FOLDER_ID.
 *
 * Deploy: Deploy > New deployment > Web app; Execute as: Me; Who has access: Anyone.
 * Every change: Deploy > Manage deployments > edit (pencil) > Version: New version > Deploy (the URL stays the same).
 */

const TABS = {
  users:    ['email', 'name', 'status', 'super', 'created', 'note', 'last_seen', 'last_ip', 'last_dal_ip'],
  devices:  ['device_id', 'email', 'name', 'token', 'status', 'created', 'verified', 'approved', 'last_seen', 'ip', 'dal_ip', 'ua', 'screen', 'verify_code', 'ever_approved'],
  log:      ['time', 'email', 'device_id', 'event', 'detail', 'version', 'ip', 'dal_ip'],
  feedback: ['time', 'email', 'name', 'type', 'text', 'context', 'image', 'version', 'status'],
  config:   ['key', 'value', 'note'],
};
const DEFAULTS = [
  ['ADMIN_EMAIL', 'c.yang@dal.ca', 'who gets approval requests and feedback'],
  ['DAL_RANGES', '129.173.0.0/16, 134.190.0.0/16', 'Dalhousie network (AS8111); used only to label requests'],
  ['LATEST_VERSION', '0.1.2', 'same as the top entry of versions.js; users with an older page see "new version available"'],
  ['NOTICE', '', 'optional one-line message shown to every user'],
  ['EXEC_URL', 'https://script.google.com/macros/s/AKfycbxzJQU8eP294Qrvgxo0k-5s7394FpAZSZjqmdpkM_akae0aj_iD5nWJgMKTzwjLVYeWAA/exec', 'this web app /exec address (Manage deployments); used in verify / approve email links'],
  ['APP_URL', '', 'GitHub Pages address, e.g. https://USER.github.io/cellpeek/'],
  ['FEEDBACK_FOLDER_ID', '', 'Drive folder for feedback screenshots; empty = a "feedback_images" folder next to this Sheet'],
];

// ------------------------------------------------------------ one-time setup (run from the editor)
function setup() {
  const ss = SpreadsheetApp.getActive();
  for (const [name, head] of Object.entries(TABS)) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) { sh.appendRow(head); sh.setFrozenRows(1); sh.getRange(1, 1, 1, head.length).setFontWeight('bold'); }
  }
  const cfg = ss.getSheetByName('config'), have = cfg.getDataRange().getValues().map(r => r[0]);
  for (const r of DEFAULTS) if (!have.includes(r[0])) cfg.appendRow(r);
  let st = ss.getSheetByName('stats');
  if (!st) {
    st = ss.insertSheet('stats');
    st.getRange('A1:B9').setValues([
      ['Approved devices', '=COUNTIF(devices!E:E,"approved")'],
      ['Waiting for approval', '=COUNTIF(devices!E:E,"pending")'],
      ['People', '=COUNTA(users!A:A)-1'],
      ['Page opens, last 7 days', '=COUNTIFS(log!D:D,"open",log!A:A,">="&(TODAY()-7))'],
      ['Cells loaded, last 7 days', '=COUNTIFS(log!D:D,"cell",log!A:A,">="&(TODAY()-7))'],
      ['Plots, last 7 days', '=COUNTIFS(log!D:D,"plot",log!A:A,">="&(TODAY()-7))'],
      ['PNG exports, last 7 days', '=COUNTIFS(log!D:D,"export",log!A:A,">="&(TODAY()-7))'],
      ['Errors, last 7 days', '=COUNTIFS(log!D:D,"error",log!A:A,">="&(TODAY()-7))'],
      ['Open feedback', '=COUNTIF(feedback!I:I,"new")'],
    ]);
    st.getRange('A11').setValue('Users in the last 7 days');
    st.getRange('A12').setFormula('=IFERROR(QUERY(log!A:D,"select B, count(D) where A >= date \'"&TEXT(TODAY()-7,"yyyy-mm-dd")&"\' and B <> \'\' group by B order by count(D) desc label count(D) \'events\'",1),"")');
    st.setColumnWidth(1, 230);
  }
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('SECRET')) p.setProperty('SECRET', Utilities.getUuid() + Utilities.getUuid());
  ss.setActiveSheet(ss.getSheetByName('stats'));
  return 'setup done';
}

// ------------------------------------------------------------ helpers
const ss_ = () => SpreadsheetApp.getActive();
function cfg_(key) {
  const rows = ss_().getSheetByName('config').getDataRange().getValues();
  for (const r of rows) if (r[0] === key) return String(r[1]).trim();
  const d = DEFAULTS.find(x => x[0] === key); return d ? d[1] : '';
}
function table_(name) {
  const sh = ss_().getSheetByName(name), v = sh.getDataRange().getValues(), head = v[0];
  return {sh, head, rows: v.slice(1), col: k => head.indexOf(k)};
}
function find_(name, key, val) {                      // -> {row (1-based sheet row), obj}
  const t = table_(name), c = t.col(key);
  for (let i = 0; i < t.rows.length; i++) if (String(t.rows[i][c]) === String(val)) {
    const o = {}; t.head.forEach((h, j) => o[h] = t.rows[i][j]); return {row: i + 2, obj: o, t};
  }
  return null;
}
function update_(name, row, fields) {
  const sh = ss_().getSheetByName(name), head = TABS[name];
  for (const [k, v] of Object.entries(fields)) sh.getRange(row, head.indexOf(k) + 1).setValue(v);
}
function append_(name, obj) { ss_().getSheetByName(name).appendRow(TABS[name].map(k => obj[k] === undefined ? '' : obj[k])); }
function rand_(n) { let s = ''; while (s.length < n) s += Utilities.getUuid().replace(/-/g, ''); return s.slice(0, n); }
function sig_(id, what) {
  const b = Utilities.computeHmacSha256Signature(id + '|' + what, PropertiesService.getScriptProperties().getProperty('SECRET'));
  return Utilities.base64EncodeWebSafe(b).replace(/=+$/, '');
}
function ipInRanges_(ip, ranges) {
  const m = String(ip || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); if (!m) return false;
  const n = ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]);
  return ranges.split(',').map(s => s.trim()).filter(Boolean).some(r => {
    const [base, bits] = r.split('/'), b = base.split('.').map(Number);
    const bn = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3], mask = bits === '0' ? 0 : (~0 << (32 - (+bits || 32))) >>> 0;
    return ((n & mask) >>> 0) === ((bn & mask) >>> 0);
  });
}
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function page_(title, msg) {
  return HtmlService.createHtmlOutput(`<div style="font:15px/1.5 -apple-system,Segoe UI,sans-serif;max-width:520px;margin:60px auto;padding:0 16px">
    <h2 style="font-size:18px">CellPeek</h2><p><b>${title}</b></p><p>${msg}</p></div>`).setTitle('CellPeek');
}
const esc_ = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const now_ = () => new Date();
function mail_(to, subject, html) { MailApp.sendEmail({to, subject, htmlBody: html, name: 'CellPeek'}); }
function device_(d) {                                 // device row from {device_id, token}
  if (!d.device_id || !d.token) return null;
  const f = find_('devices', 'device_id', d.device_id);
  return f && f.obj.token && f.obj.token === d.token ? f : null;
}
// 邮件里的链接一律用正式 /exec 地址（getService().getUrl() 有时给出只有编辑者能开的 /dev 地址）
function execUrl_() { return cfg_('EXEC_URL') || ScriptApp.getService().getUrl().replace(/\/dev$/, '/exec'); }
function appUrl_() { return cfg_('APP_URL') || execUrl_(); }        // 邮件链接指向 CellPeek 页面
const msg_ = (title, msg) => ({title, msg});
const pageOf_ = r => page_(r.title, r.msg);
function link_(d) {                                                  // 页面转交过来的邮件链接
  const p = {a: String(d.a || ''), d: String(d.d || ''), c: String(d.c || ''), s: String(d.s || '')};
  if (p.a === 'verify') return verify_(p);
  if (p.a === 'approve' || p.a === 'deny') return decide_(Object.assign(p, {confirm: d.confirm === true}));   // 先确认、再点按钮才生效
  return msg_('Link not valid.', '');
}
function userOf_(email) { const f = find_('users', 'email', email); return f ? f.obj : null; }

// ------------------------------------------------------------ web app entry points
function doPost(e) {
  let d; try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({error: 'bad request'}); }
  if (d.action === 'index') { try { return json_(index_(d)); } catch (err) { return json_({error: String(err.message || err)}); } }
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    switch (d.action) {
      case 'register': return json_(register_(d));
      case 'session':  return json_(session_(d));
      case 'log':      return json_(log_(d));
      case 'feedback': return json_(feedback_(d));
      case 'link':     return json_(link_(d));
      case 'verify':   return json_(verifyCode_(d));
      case 'logout':   return json_(logout_(d));
      default:         return json_({error: 'unknown action'});
    }
  } catch (err) { return json_({error: String(err.message || err)}); }
  finally { lock.releaseLock(); }
}

function doGet(e) {
  const p = e.parameter || {};
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (p.a === 'verify') return pageOf_(verify_(p));
    if (p.a === 'approve' || p.a === 'deny') return page_('Please open this link from the newest email.', 'Approve / Deny now only works through the CellPeek page.');   // 旧 /exec 链接不再直接审批
    return json_({ok: true, app: 'CellPeek backend'});
  } finally { lock.releaseLock(); }
}

// ------------------------------------------------------------ actions
function register_(d) {
  const email = String(d.email || '').trim().toLowerCase(), name = String(d.name || '').trim().slice(0, 80);
  if (!/^[^@\s]+@dal\.ca$/.test(email)) return {error: 'Please use your @dal.ca email address.'};
  if (!name) return {error: 'Please enter your name.'};
  if (!d.device_id || String(d.device_id).length < 8) return {error: 'bad device id'};
  const cache = CacheService.getScriptCache(), rk = 'reg_' + d.device_id, n = +(cache.get(rk) || 0);
  if (n >= 5) return {error: 'Too many requests from this computer; please try again in an hour.'};
  cache.put(rk, String(n + 1), 3600);
  const u = userOf_(email);
  if (u && u.status === 'revoked') return {error: 'Access for this email has been switched off. Please contact the administrator.'};
  if (!u) append_('users', {email, name, status: 'active', super: false, created: now_()});

  const token = rand_(40), code = ('00000' + Math.floor(Math.random() * 1e6)).slice(-6), dal = ipInRanges_(d.ip, cfg_('DAL_RANGES'));
  const f = find_('devices', 'device_id', d.device_id);
  const rec = {email, name, token, status: 'unverified', verify_code: code, ip: d.ip || '', dal_ip: dal ? 'yes' : 'no',
               ua: String(d.ua || '').slice(0, 300), screen: d.screen || '', verified: '', approved: ''};
  if (f) {
    rec.ever_approved = (f.obj.ever_approved && f.obj.email === email) ? f.obj.ever_approved : '';   // same person, same computer, approved before
    update_('devices', f.row, rec);
  } else append_('devices', Object.assign({device_id: d.device_id, created: now_(), ever_approved: ''}, rec));

  const cache2 = CacheService.getScriptCache();
  cache2.put('vct_' + d.device_id, '1', 1800); // code valid 30 min
  cache2.remove('vca_' + d.device_id); // reset wrong-try count
  mail_(email, `CellPeek verification code: ${code}`,
    `<p>Hi ${esc_(name)},</p><p>Your CellPeek verification code is:</p>
     <p style="font:bold 28px/1.2 monospace;letter-spacing:6px">${code}</p>
     <p>Type it on the CellPeek page. It is valid for 30 minutes.</p>
     <p style="color:#666">If you did not ask for this, ignore this email.</p>`);
  return {status: 'unverified', token};
}

// User types the 6-digit code from the email (no link in the email, so scanners can't confirm for them)
function verifyCode_(d) {
  const f = device_(d);
  if (!f) return {error: 'Please click Start over.'};
  if (f.obj.status !== 'unverified') return session_(d);
  const cache = CacheService.getScriptCache(), ak = 'vca_' + d.device_id, n = +(cache.get(ak) || 0);
  if (n >= 5) return {error: 'Too many wrong codes. Please click Start over to get a new code.'};
  if (!cache.get('vct_' + d.device_id)) return {error: 'This code has expired. Please click Start over to get a new code.'};
  const want = String(f.obj.verify_code).padStart(6, '0'), got = String(d.code || '').replace(/\D/g, '');
  if (got !== want) { cache.put(ak, String(n + 1), 1800); return {error: `Wrong code (${4 - n} tries left).`}; }
  cache.remove(ak); cache.remove('vct_' + d.device_id);
  verify_({d: d.device_id, c: f.obj.verify_code}); // -> pending + admin email (or auto-approve known device)
  return session_(d);
}

function verify_(p) {
  const f = find_('devices', 'device_id', p.d);
  if (!f || !f.obj.verify_code || f.obj.verify_code !== p.c) return msg_('This link is not valid any more.', 'Please start again on the CellPeek page.');
  const o = f.obj;
  if (o.ever_approved) {                               // re-login on a computer this person used before: no new approval needed
    update_('devices', f.row, {status: 'approved', verified: now_(), approved: now_(), verify_code: ''});
    return msg_('Email confirmed.', 'You can go back to the CellPeek page now.');
  }
  update_('devices', f.row, {status: 'pending', verified: now_(), verify_code: ''});
  const base = appUrl_() + `?d=${encodeURIComponent(o.device_id)}`;
  const others = table_('devices').rows.filter(r => r[1] === o.email && r[4] === 'approved').length;
  const sup = (userOf_(o.email) || {}).super === true;
  mail_(cfg_('ADMIN_EMAIL'), `CellPeek: access request from ${o.name} (${o.email})`,
    `<table style="font:14px -apple-system,Segoe UI,sans-serif;border-collapse:collapse">
      <tr><td style="padding:3px 12px 3px 0;color:#666">Name</td><td>${esc_(o.name)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">Email</td><td>${esc_(o.email)} (confirmed)</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">Time</td><td>${now_()}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">IP</td><td>${esc_(o.ip || 'unknown')} — <b>${o.dal_ip === 'yes' ? 'Dal network' : 'NOT a Dal address'}</b></td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">Browser</td><td>${esc_(o.ua)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">Screen</td><td>${esc_(o.screen)}</td></tr>
      <tr><td style="padding:3px 12px 3px 0;color:#666">Other approved computers</td><td>${others}${sup ? ' · super user' : ''}</td></tr>
    </table>
    <p style="margin-top:16px">
      <a href="${base}&a=approve&s=${sig_(o.device_id, 'approve')}" style="background:#1a7f37;color:#fff;padding:8px 18px;border-radius:5px;text-decoration:none">Approve</a>
      &nbsp; <a href="${base}&a=deny&s=${sig_(o.device_id, 'deny')}" style="background:#b42318;color:#fff;padding:8px 18px;border-radius:5px;text-decoration:none">Deny</a></p>
    <p style="color:#666">Device id ${esc_(o.device_id)}. You can change anything later in the Sheet (devices / users tabs).</p>`);
  return msg_('Email confirmed.', 'Your request has been sent to the administrator. The CellPeek page will open by itself once it is approved.');
}

function decide_(p) {
  const f = find_('devices', 'device_id', p.d);
  if (!f || p.s !== sig_(p.d, p.a)) return msg_('Link not valid.', '');
  const o = f.obj;
  // 邮件安全扫描会自动打开链接（2026-11-08：申请邮件发出 17 秒后被自动 Approve），所以链接本身只显示确认，要在页面上再点按钮才生效
  if (p.confirm !== true) return Object.assign(msg_(`${p.a === 'approve' ? 'Approve' : 'Deny'} access for ${o.name} (${o.email})?`,
    `IP ${esc_(o.ip || 'unknown')} — <b>${o.dal_ip === 'yes' ? 'Dal network' : 'NOT a Dal address'}</b>. Current status: ${esc_(o.status)}.`), {need_confirm: true, a: p.a});
  if (p.a === 'approve') {
    update_('devices', f.row, {status: 'approved', approved: now_(), ever_approved: now_()});
    const app = cfg_('APP_URL');
    mail_(o.email, 'CellPeek: access approved',
      `<p>Hi ${esc_(o.name)},</p><p>Your access has been approved. ${app ? `Open <a href="${app}">${app}</a>` : 'Go back to the page'} in Chrome or Edge.</p>`);
    return msg_('Approved.', `${esc_(o.name)} (${esc_(o.email)}) can use the page on this computer now.`);
  }
  update_('devices', f.row, {status: 'denied'});
  return msg_('Denied.', `${esc_(o.name)} (${esc_(o.email)}) was not given access.`);
}

function session_(d) {
  const f = device_(d);
  if (!f) return {status: 'unknown'};
  const o = f.obj, u = userOf_(o.email) || {};
  let status = o.status;
  if (u.status === 'revoked' && status === 'approved') status = 'revoked';
  if (status === 'approved') touch_(f, d.ip);
  const out = {status, email: o.email, name: o.name};
  if (status === 'approved') Object.assign(out, {super: u.super === true, latest_version: cfg_('LATEST_VERSION'), notice: cfg_('NOTICE')});
  return out;
}

// IP 是否属于 DAL_RANGES：'yes' / 'no'；没有 IP 时留空
function dal_(ip) { ip = String(ip || '').trim(); return ip ? (ipInRanges_(ip, cfg_('DAL_RANGES')) ? 'yes' : 'no') : ''; }

// 更新"最近使用时间 / 最近 IP / 是否 Dal IP"：devices 表和 users 表都写；同一 IP 5 分钟内只写一次
function touch_(f, ip) {
  const o = f.obj, t = now_(), last = o.last_seen ? new Date(o.last_seen).getTime() : 0;
  ip = String(ip || '').trim();
  if (Date.now() - last < 5 * 60000 && (!ip || ip === String(o.ip))) return;
  const dal = dal_(ip), dev = {last_seen: t};
  if (ip) { dev.ip = ip; dev.dal_ip = dal; }
  update_('devices', f.row, dev);
  const u = find_('users', 'email', o.email);
  if (u) update_('users', u.row, ip ? {last_seen: t, last_ip: ip, last_dal_ip: dal} : {last_seen: t});
}

function log_(d) {
  const f = device_(d); if (!f || f.obj.status !== 'approved') return {ok: false};
  touch_(f, d.ip);
  const ev = (d.events || []).slice(0, 50);
  if (!ev.length) return {ok: true};
  const dal = dal_(d.ip);
  const rows = ev.map(x => [new Date(x.t || Date.now()), f.obj.email, d.device_id, String(x.event).slice(0, 30), String(x.detail || '').slice(0, 1000), d.version || '', d.ip || '', dal]);
  const sh = ss_().getSheetByName('log');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  return {ok: true};
}

function feedback_(d) {
  const f = device_(d); if (!f || f.obj.status !== 'approved') return {error: 'not signed in'};
  const o = f.obj; let link = '';
  if (d.image && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(d.image)) {
    const [head, b64] = d.image.split(','), type = head.slice(5, head.indexOf(';'));
    const blob = Utilities.newBlob(Utilities.base64Decode(b64), type,
      Utilities.formatDate(now_(), 'America/Halifax', 'yyyyMMdd_HHmmss') + '_' + o.email.split('@')[0] + '_' + String(d.image_name || 'screenshot').replace(/[^\w.-]/g, '_'));
    link = feedbackFolder_().createFile(blob).getUrl();
  }
  const ctx = JSON.stringify(d.context || {}).slice(0, 5000);
  append_('feedback', {time: now_(), email: o.email, name: o.name, type: d.type || '', text: String(d.text || '').slice(0, 5000), context: ctx, image: link, version: d.version || '', status: 'new'});
  mail_(cfg_('ADMIN_EMAIL'), `CellPeek ${d.type || 'feedback'} from ${o.name}`,
    `<p><b>${esc_(d.type)}</b> from ${esc_(o.name)} (${esc_(o.email)}), version ${esc_(d.version)}</p>
     <p style="white-space:pre-wrap">${esc_(d.text)}</p>${link ? `<p>Screenshot: <a href="${link}">${link}</a></p>` : ''}
     <p style="color:#666;font-size:12px">${esc_(ctx)}</p>`);
  return {ok: true};
}
function feedbackFolder_() {
  const id = cfg_('FEEDBACK_FOLDER_ID');
  if (id) return DriveApp.getFolderById(id);
  const parent = DriveApp.getFileById(ss_().getId()).getParents();
  const base = parent.hasNext() ? parent.next() : DriveApp.getRootFolder();
  const it = base.getFoldersByName('feedback_images');
  return it.hasNext() ? it.next() : base.createFolder('feedback_images');
}

function logout_(d) {
  const f = device_(d); if (f) update_('devices', f.row, {status: 'logged_out', token: ''});
  return {ok: true};
}

// ----------------------------------------------------------------- file index from the office PC (tools/build_index.py)
// cellpeek_index.json is written twice a day into the same Drive folder as this Sheet (or set INDEX_FILE_ID in config).
function index_(d) {
  const f = device_(d); if (!f || f.obj.status !== 'approved') return {error: 'not signed in'};
  const file = indexFile_(); if (!file) return {none: true};
  const tf = String(file.getLastUpdated().getTime());
  if (String(d.have || '') === tf) return {same: true, t_file: tf};
  const j = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  j.t_file = tf; delete j.data;
  return j;
}
function indexFile_() {
  const p = PropertiesService.getScriptProperties();
  for (const id of [cfg_('INDEX_FILE_ID'), p.getProperty('INDEX_FILE_ID')]) {
    if (!id) continue;
    try { const f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (e) {}
  }
  const parents = DriveApp.getFileById(ss_().getId()).getParents();
  if (!parents.hasNext()) return null;
  const it = parents.next().getFilesByName('cellpeek_index.json');
  if (!it.hasNext()) return null;
  const f = it.next(); p.setProperty('INDEX_FILE_ID', f.getId());
  return f;
}

// ------------------------------------------------------------ quick self-test (run from the editor; checks the IP ranges)
function testRanges() {
  Logger.log([ipInRanges_('129.173.10.20', cfg_('DAL_RANGES')), ipInRanges_('134.190.1.1', cfg_('DAL_RANGES')), ipInRanges_('8.8.8.8', cfg_('DAL_RANGES'))]);
}

// 一次性：给已有的表补表头（新列都在最后）
function addColumns() {
  for (const [name, head] of Object.entries(TABS)) {
    const sh = ss_().getSheetByName(name); if (!sh) continue;
    const have = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0];
    head.forEach((h, i) => { if (have[i] !== h) sh.getRange(1, i + 1).setValue(h).setFontWeight('bold'); });
  }
  return 'columns ok';
}



