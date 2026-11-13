// CellPeek — login / approval gate, data-folder step, user badge, feedback, usage log, version notice.
// Talks to the Apps Script backend (NQP_CONFIG.APPS_SCRIPT_URL). Stored in this browser only:
//   localStorage nqp_device (random id of this computer, kept after log-out), nqp_auth (token + email), nqp_src / nqp_remote (super users)
//   IndexedDB: the CYCLING folder handle and parsed-file cache (cleared on log-out)
'use strict';
(function () {
const NQP = window.NQP = window.NQP || {}, C = window.NQP_CONFIG || {}, $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const LS = {get: k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
            set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
            del: k => { try { localStorage.removeItem(k); } catch {} }};
const deviceId = () => { let d = LS.get('nqp_device'); if (!d) { d = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); LS.set('nqp_device', d); } return d; };
const auth = () => LS.get('nqp_auth') || {};
let USER = null;

async function call(action, payload = {}) {
  const r = await fetch(C.APPS_SCRIPT_URL, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'},
    body: JSON.stringify({action, device_id: deviceId(), token: auth().token || '', version: C.APP_VERSION, ip: IP, ...payload})});
  const j = await r.json(); if (j.error) throw new Error(j.error); return j;
}
NQP.call = call;                                   // data.js: office-PC file index ('index' action)
async function publicIp() {
  try { const c = new AbortController(); setTimeout(() => c.abort(), 3000);
    return (await (await fetch('https://api.ipify.org?format=json', {signal: c.signal})).json()).ip || ''; } catch { return ''; }
}
let IP = ''; const ipP = publicIp().then(x => (IP = x));

// ---------- gate (full-screen card shown until the user may use the page) ----------
function gate(html) { const g = $('#gate'); g.hidden = false; $('#gatecard').innerHTML = html; return $('#gatecard'); }
function openPage() { $('#gate').hidden = true; }
const TITLE = `<h2>CellPeek - DAL</h2>`;

function showRegister(msg) {
  const c = gate(`${TITLE}<p>First time on this computer. Please tell us who you are; your request is sent to the administrator.</p>
    <label>Name<input id="g_name" type="text" autocomplete="name"></label>
    <label>Dal email<input id="g_email" type="email" placeholder="name@dal.ca" autocomplete="email"></label>
    <div class="gerr">${esc(msg || '')}</div><button class="primary" id="g_go">Send request</button>`);
  $('#g_go', c).onclick = async () => {
    const name = $('#g_name', c).value.trim(), email = $('#g_email', c).value.trim().toLowerCase();
    if (!name) return ($('.gerr', c).textContent = 'Please enter your name.');
    if (!/^[^@\s]+@dal\.ca$/.test(email)) return ($('.gerr', c).textContent = 'Please use your @dal.ca email address.');
    $('#g_go', c).disabled = true; $('.gerr', c).textContent = 'Sending…';
    try {
      const j = await call('register', {name, email, ip: await publicIp(), ua: navigator.userAgent, screen: `${screen.width}x${screen.height}`});
      LS.set('nqp_auth', {token: j.token, email, name}); route(j);
    } catch (e) { $('#g_go', c).disabled = false; $('.gerr', c).textContent = e.message; }
  };
}
let pollT = null;
function showWaiting(s) {
  const a = auth(), verify = s.status === 'unverified';
  if (verify) {                                  // type the 6-digit code from the email (no link: mail scanners open links by themselves)
    clearTimeout(pollT);
    const c = gate(`${TITLE}<p>We sent a 6-digit code to <b>${esc(a.email)}</b>. Please type it here (check Junk too).</p>
      <label>Code<input id="g_code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"></label>
      <div class="gerr"></div><button class="primary" id="g_ver">Verify</button> <button id="g_over">Start over</button>`);
    const go = async () => {
      const code = $('#g_code', c).value.replace(/\D/g, '');
      if (code.length !== 6) return ($('.gerr', c).textContent = 'Please enter the 6 digits.');
      $('#g_ver', c).disabled = true; $('.gerr', c).textContent = 'Checking…';
      try { route(await call('verify', {code})); }
      catch (e) { $('#g_ver', c).disabled = false; $('.gerr', c).textContent = e.message; }
    };
    $('#g_ver', c).onclick = go;
    $('#g_code', c).onkeydown = ev => { if (ev.key === 'Enter') go(); };
    $('#g_over', c).onclick = () => logout(true);
    $('#g_code', c).focus();
    return;
  }
  const c = gate(`${TITLE}<p>${verify
      ? `We sent a verification link to <b>${esc(a.email)}</b>. Please open it (check Junk too).`
      : `Thanks, <b>${esc(a.email)}</b> is verified. Waiting for the administrator to approve this computer.`}</p>
    <p class="gmuted">This page checks every 20 seconds.</p>
    <button id="g_chk">Check now</button> <button id="g_over">Start over</button>`);
  $('#g_chk', c).onclick = () => check();
  $('#g_over', c).onclick = () => logout(true);
  clearTimeout(pollT); pollT = setTimeout(check, 20000);
}
function showBlocked(s) {
  const c = gate(`${TITLE}<p>${s.status === 'denied' ? 'Your request was not approved.' : 'Access for this computer has been switched off.'}
    Please contact Chongyin Yang (c.yang@dal.ca).</p><button id="g_over">Start over</button>`);
  $('#g_over', c).onclick = () => logout(true);
}
async function check() {
  clearTimeout(pollT);
  try { await ipP; route(await call('session')); } catch (e) { gate(`${TITLE}<p class="gerr">Cannot reach the login server: ${esc(e.message)}</p><button onclick="location.reload()">Retry</button>`); }
}
function route(s) {
  if (s.status === 'approved') return approved(s);
  if (s.status === 'unverified' || s.status === 'pending') return showWaiting(s);
  if (s.status === 'denied' || s.status === 'revoked') return showBlocked(s);
  LS.del('nqp_auth'); showRegister();
}

// ---------- links from the emails (verify / approve / deny) ----------
// The emails link here instead of to script.google.com, so they also open in browsers signed in to several Google accounts.
async function linkStep(q) {
  const args = {a: q.get('a'), d: q.get('d') || '', c: q.get('c') || '', s: q.get('s') || ''};
  const ask = async extra => {
    try { return await call('link', Object.assign({}, args, extra)); }
    catch (e) { return {title: 'Cannot reach the login server.', msg: esc(e.message)}; }
  };
  gate(`${TITLE}<p class="gmuted">Checking the link…</p>`);
  let r = await ask({});
  if (r.need_confirm) { // approve / deny: mail scanners open links by themselves, so a person has to click
    const c = gate(`${TITLE}<p><b>${esc(r.title)}</b></p><p>${r.msg || ''}</p>
      <button class="primary" id="g_yes">${args.a === 'approve' ? 'Approve' : 'Deny'}</button> <button id="g_no">Cancel</button>`);
    const yes = await new Promise(res => { $('#g_yes', c).onclick = () => res(true); $('#g_no', c).onclick = () => res(false); });
    if (!yes) { history.replaceState(null, '', location.pathname); return location.reload(); }
    gate(`${TITLE}<p class="gmuted">Saving…</p>`);
    r = await ask({confirm: true});
  }
  history.replaceState(null, '', location.pathname);
  const c = gate(`${TITLE}<p><b>${esc(r.title)}</b></p><p>${r.msg || ''}</p><button class="primary" id="g_cont">OK</button>`);
  $('#g_cont', c).onclick = () => location.reload();
}

// ---------- after approval ----------
function approved(s) {
  clearTimeout(pollT);
  USER = {email: s.email, name: s.name, super: !!s.super};
  LS.set('nqp_auth', {...auth(), email: s.email, name: s.name});
  const who = $('#who'); who.hidden = false;
  who.innerHTML = `<span title="${esc(s.name)}">${esc(s.email)}</span><a href="#" title="Log out and forget this computer's settings">✕</a>`;
  $('a', who).onclick = ev => { ev.preventDefault(); logout(false); };
  $('#fbbtn').hidden = false;
  if (s.notice) { const b = $('#banner'); b.hidden = false; b.insertAdjacentHTML('beforeend', ' ' + esc(s.notice)); }
  NQP.logLeftover(); NQP.log('open', {});
  dataStep();
}

// ---------- data source step ----------
function srcLabel() {
  const el = $('#src'), S = NQP.source; el.hidden = false;
  if (S.mode === 'server') { el.textContent = 'Data: office server'; return; }
  const sup = USER && USER.super;
  if (S.mode === 'remote') {
    el.innerHTML = `Data: remote · ${esc(S.base.replace(/^https?:\/\//, ''))} <a href="#" id="srcchg">change</a>`;
  } else if (NQP.folder.name()) {
    el.innerHTML = `Data: ${esc(NQP.folder.name())} <a href="#" id="srcchg">change</a>`;
  } else if (FOLDER_STATE === 'prompt') {              // folder remembered, browser wants permission again
    el.innerHTML = `Data: <a href="#" id="srcallow" class="srcneed" title="Allow this page to read ${esc(SAVED_NAME)} again">allow ${esc(SAVED_NAME)}</a> · <a href="#" id="srcchg">change</a>`;
  } else {                                             // nothing connected yet
    el.innerHTML = `Data: <a href="#" id="srcchg" class="srcneed" title="Choose the CYCLING folder on the data drive, e.g. Z:\\databdayse\\DATA\\CYCLING (read-only, remembered on this computer)">connect CYCLING folder</a>`;
  }
  $('#srcchg').onclick = ev => { ev.preventDefault(); sup ? chooseSource() : pickFolder(true); };
  if ($('#srcallow')) $('#srcallow').onclick = async ev => { ev.preventDefault();
    if (await NQP.folder.reconnect()) { FOLDER_STATE = 'granted'; srcLabel(); folderReady(); NQP.log('folder', {name: NQP.folder.name(), how: 'reconnect'}); } };
}
let FOLDER_STATE = 'none', SAVED_NAME = '';
function folderReady() { status('Data folder: ' + NQP.folder.roots().join(' + ')); if (NQP.retryCells) NQP.retryCells(); }
async function dataStep() {
  const r = LS.get('nqp_src');
  if (USER && USER.super && r === 'remote' && LS.get('nqp_remote')) { useRemote(LS.get('nqp_remote')); return openPage(); }
  if (!NQP.folder.supported()) return gate(`${TITLE}<p>Please open this page in <b>Google Chrome</b> or <b>Microsoft Edge</b>.
    Other browsers cannot read a folder on your computer.</p>${USER && USER.super ? '<button id="g_rm">Use remote server instead</button>' : ''}`)
    , USER && USER.super && ($('#g_rm').onclick = chooseSource);
  // the page opens right away; the data folder is connected from "Data: ..." in the header
  FOLDER_STATE = await NQP.folder.state();
  if (FOLDER_STATE === 'granted') await NQP.folder.useSaved();
  else if (FOLDER_STATE === 'prompt') SAVED_NAME = (await NQP.folder.saved()).name;
  NQP.source.mode = 'local'; srcLabel(); openPage();
  if (FOLDER_STATE !== 'granted') status(FOLDER_STATE === 'prompt'
    ? `Click "allow ${SAVED_NAME}" next to Data (top right) to read the data folder again.`
    : 'To start, click "connect CYCLING folder" next to Data (top right).');
  DATA_STEP = true; folderPrompt();
}
// Neware Cycling opened without a readable data folder: offer to connect it (once per page load; "Not now" closes it)
let DATA_STEP = false, FOLD_ASKED = false;
function folderPrompt() {
  const d = $('#fold');
  if (!d || !DATA_STEP || FOLD_ASKED || NQP.source.mode !== 'local' || FOLDER_STATE === 'granted') return;
  if (!$('#tabs [data-tab=neware].on') || !$('#gate').hidden || $('dialog[open]')) return;
  FOLD_ASKED = true;
  const again = FOLDER_STATE === 'prompt', sup = USER && USER.super, go = $('#fo_go'), other = $('#fo_other');
  $('#fo_body').innerHTML = again
    ? `<p>Neware Cycling reads the cycling files from your data folder <b>${esc(SAVED_NAME)}</b>. The browser asks for permission again after a restart.</p>
       <p class="gmuted">Tip: in the browser prompt choose <i>Allow on every visit</i> to skip this step next time.</p>`
    : `<p>Neware Cycling reads the cycling files straight from the data drive. Choose the <b>CYCLING</b> folder, for example<br><code>Z:\\databdayse\\DATA\\CYCLING</code></p>
       <p class="gmuted">The page only reads files (read-only); the folder is remembered on this computer. You can also do this later from "Data:" at the top right.</p>`;
  go.textContent = again ? `Allow ${SAVED_NAME}` : 'Choose folder…';
  other.hidden = !(again || sup); other.textContent = sup ? 'Other source…' : 'Choose another folder…';
  go.onclick = async () => { d.close();
    if (!again) return pickFolder();
    if (await NQP.folder.reconnect()) { FOLDER_STATE = 'granted'; srcLabel(); folderReady(); NQP.log('folder', {name: NQP.folder.name(), how: 'reconnect'}); } };
  other.onclick = () => { d.close(); sup ? chooseSource() : pickFolder(); };
  $('#fo_x').onclick = $('#fo_no').onclick = () => d.close();
  d.showModal(); go.focus();
}
window.addEventListener('cellpeek:tab', folderPrompt);
async function pickFolder() {
  try {
    const r = await NQP.folder.pick(); FOLDER_STATE = 'granted';
    NQP.source.mode = 'local'; LS.set('nqp_src', 'local'); srcLabel(); openPage(); NQP.log('folder', {name: r.name, roots: r.roots});
    folderReady();
    if (!r.roots.some(n => /NEWARE/i.test(n))) status('Note: no NEWARE folder found inside ' + r.name + '; searching this folder only.');
  } catch (e) { if (e.name !== 'AbortError') status('Folder: ' + e.message); }
}
function useRemote(r) { Object.assign(NQP.source, {mode: 'remote', base: r.base, token: r.token}); srcLabel(); }

// super users: local folder or remote server (Tailscale)
function chooseSource() {
  const d = $('#rmt'), r = LS.get('nqp_remote') || {};
  $('#rm_base').value = r.base || ''; $('#rm_tok').value = r.token || ''; $('#rm_msg').textContent = '';
  d.showModal();
}
function initRemoteDialog() {
  const d = $('#rmt');
  $('#rm_x').onclick = () => d.close();
  $('#rm_local').onclick = () => { d.close(); NQP.source.base = ''; pickFolder(); };
  $('#rm_go').onclick = async () => {
    const r = {base: $('#rm_base').value.trim().replace(/\/+$/, ''), token: $('#rm_tok').value.trim()};
    $('#rm_msg').textContent = 'Testing…';
    try {
      const j = await (await fetch(r.base + '/api/info' + (r.token ? '?token=' + encodeURIComponent(r.token) : ''))).json();
      if (!j.roots) throw new Error(j.error || 'unexpected answer');
      LS.set('nqp_remote', r); LS.set('nqp_src', 'remote'); useRemote(r); d.close(); openPage();
      status('Remote server: ' + j.roots[0]); NQP.log('remote', {base: r.base});
    } catch (e) { $('#rm_msg').textContent = 'Cannot reach it: ' + e.message; }
  };
}

// ---------- log out ----------
async function logout(silent) {
  try { if (C.APPS_SCRIPT_URL && auth().token) await call('logout'); } catch {}
  LS.del('nqp_auth'); LS.del('nqp_src'); LS.del('nqp_remote');
  await NQP.folder.forget(); await NQP.clearCache().catch(() => {});
  location.reload();
}

// ---------- usage log: one row per stretch of work ----------
// Everything done in one stretch (cells loaded, plots, exports, errors …) is collected into a single 'session' entry.
// It is sent when the page is closed, or after LOG_IDLE without any activity; a stretch that could not be sent
// (crash, computer switched off) is kept in this browser and sent the next time the page opens.
const LOG_IDLE = 10 * 60000, errs = [];
let seg = null, segT = null;
const segNew = t => ({t0: t, t1: t, n: {}, cells: [], plots: [], exports: [], errors: [], folder: ''});
const add = (arr, v, max) => { if (v != null && v !== '' && !arr.includes(v) && arr.length < max) arr.push(v); };
NQP.log = (event, detail) => {
  if (!C.APPS_SCRIPT_URL || !USER) return;
  const t = new Date().toISOString(), d = detail && typeof detail === 'object' ? detail : {};
  if (event === 'error') { errs.push({t, event, detail: String(detail)}); errs.length > 20 && errs.shift(); }
  if (!seg) seg = segNew(t);
  seg.t1 = t; seg.n[event] = (seg.n[event] || 0) + 1;
  if (event === 'cell') add(seg.cells, d.bc, 300);
  else if (event === 'plot') { (d.cells || []).forEach(c => add(seg.cells, c, 300)); (d.modules || []).forEach(m => add(seg.plots, m, 20)); }
  else if (event === 'export') add(seg.exports, d.name, 30);
  else if (event === 'folder') seg.folder = d.name || seg.folder;
  else if (event === 'error') add(seg.errors, String(detail).slice(0, 200), 8);
  LS.set('nqp_seg', seg);
  clearTimeout(segT); segT = setTimeout(flush, LOG_IDLE);
};
function segEvent(g) {
  const min = Math.round((new Date(g.t1) - new Date(g.t0)) / 60000), d = {to: g.t1, minutes: min};
  if (g.folder) d.folder = g.folder;
  if (g.cells.length) d.cells = g.cells;
  if (g.plots.length) d.plots = g.plots;
  if (g.exports.length) d.exports = g.exports;
  for (const k of ['raman_load', 'raman_export']) if (g.n[k]) d[k] = g.n[k];
  if (g.errors.length) d.errors = g.errors;
  return {t: g.t0, event: 'session', detail: JSON.stringify(d)};
}
function send(events, beacon) {
  const body = JSON.stringify({action: 'log', device_id: deviceId(), token: auth().token, version: C.APP_VERSION, ip: IP, events});
  fetch(C.APPS_SCRIPT_URL, {method: 'POST', headers: {'Content-Type': 'text/plain;charset=utf-8'}, body, keepalive: !!beacon}).catch(() => {});
}
function flush(beacon) {
  clearTimeout(segT);
  if (!seg || !USER) return;
  const g = seg; seg = null; LS.set('nqp_seg', null);
  send([segEvent(g)], beacon);
}
NQP.logLeftover = () => {                       // a stretch left over from last time (never sent): send it before a new one starts
  const g = LS.get('nqp_seg'); if (!g || !g.t0 || !g.n || seg) return;
  if (Date.now() - new Date(g.t1) < LOG_IDLE) { seg = g; return; }   // still the same stretch (e.g. after a crash and reopen): carry on with it
  LS.set('nqp_seg', null); if (USER) send([segEvent(g)]);
};
window.addEventListener('pagehide', () => flush(true));
window.addEventListener('error', e => NQP.log('error', String(e.message || e.error).slice(0, 300)));
window.addEventListener('unhandledrejection', e => NQP.log('error', String(e.reason && e.reason.message || e.reason).slice(0, 300)));

// ---------- feedback ----------
function initFeedback() {
  const d = $('#fb');
  $('#fbbtn').onclick = () => { $('#fb_msg').textContent = ''; d.showModal(); };
  $('#fb_x').onclick = () => d.close();
  $('#fb_go').onclick = async () => {
    const text = $('#fb_text').value.trim(); if (!text) return ($('#fb_msg').textContent = 'Please write a few words.');
    let image = '', f = $('#fb_img').files[0];
    if (f) { if (f.size > 5e6) return ($('#fb_msg').textContent = 'Image is larger than 5 MB.');
      image = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); }); }
    const context = {version: C.APP_VERSION, ua: navigator.userAgent, source: NQP.source.mode, folder: NQP.folder.name(),
      cells: [...document.querySelectorAll('#chips .chip b')].map(b => b.textContent),
      modules: [...document.querySelectorAll('#modebar button.on')].map(b => b.textContent),
      status: ($('#status') || {}).textContent, errors: errs.slice(-10)};
    $('#fb_go').disabled = true; $('#fb_msg').textContent = 'Sending…';
    try { await call('feedback', {type: $('#fb_type').value, text, context, image, image_name: f ? f.name : ''});
      $('#fb_text').value = ''; $('#fb_img').value = ''; d.close(); status('Thank you, feedback sent.'); }
    catch (e) { $('#fb_msg').textContent = 'Could not send: ' + e.message; }
    $('#fb_go').disabled = false;
  };
}

// ---------- start ----------
const status = t => { const s = $('#status'); if (s) s.textContent = t; };
async function isServerPy() {
  if (location.protocol === 'file:' || /github\.io$/.test(location.hostname)) return false;
  try { const c = new AbortController(); setTimeout(() => c.abort(), 1500);
    const j = await (await fetch('api/info' + location.search, {signal: c.signal})).json(); return Array.isArray(j.roots); } catch { return false; }
}
NQP.boot = async function () {
  const v = $('#ver'), V = window.NQP_VERSIONS || [];
  if (v && C.APP_VERSION) v.textContent = 'beta ' + C.APP_VERSION;
  if (v) v.onclick = ev => { ev.preventDefault();
    $('#verlist').innerHTML = V.map(x => `<div><div class="vh">${esc(x.v)}<span>${esc(x.date)}</span></div><ul>${x.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>`).join('');
    $('#verdlg').showModal(); };
  $('#ver_x').onclick = () => $('#verdlg').close();
  initFeedback(); initRemoteDialog();
  // error lines shown in the status bar are logged too
  new MutationObserver(() => { const t = $('#status').textContent; if (/^Error|failed|Cannot/i.test(t)) NQP.log('error', t.slice(0, 300)); })
    .observe($('#status'), {childList: true, characterData: true, subtree: true});
  if (await isServerPy()) {                   // old local mode: page served by server.py
    Object.assign(NQP.source, {mode: 'server', token: new URLSearchParams(location.search).get('token') || ''});
    srcLabel(); return openPage();
  }
  if (!C.APPS_SCRIPT_URL) { USER = null; return dataStep(); }     // no login configured (testing)
  const q = new URLSearchParams(location.search);
  if (/^(verify|approve|deny)$/.test(q.get('a') || '')) return linkStep(q);   // opened from an email link
  if (!auth().token) return showRegister();
  gate(`${TITLE}<p class="gmuted">Signing in…</p>`); check();
};
})();
