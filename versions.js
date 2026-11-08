// Version history, newest first. The first entry is the running version.
// Rule: the last number (0.1.x) may be bumped for small fixes; changing the first two numbers needs Chongyin's approval.
window.NQP_VERSIONS = [
  {v: '0.1.4', date: '2026-11-08', notes: ['Approve / Deny links ask for a click before they take effect (mail scanners were opening them automatically)']},
  {v: '0.1.3', date: '2026-11-08', notes: ['Email links (verify, approve) open in CellPeek, so they work with several Google accounts signed in']},
  {v: '0.1.2', date: '2026-11-08', notes: ['ΔV plots: absolute, minus a reference cycle, or divided by a reference cycle', 'Normalized plots: last-cycle % shown at the right', 'Records IP address and last-used time']},
  {v: '0.1.1', date: '2026-11-08', notes: ['Web version: sign-in with approval', 'Reads the data folder in the browser (read-only)', 'Feedback, usage log, new-version notice']},
  {v: '0.1.0', date: '2026-11-08', notes: ['First version: 9 plot types, multi-barcode input', 'Editable axis limits, PNG export']},
];
window.NQP_CONFIG = window.NQP_CONFIG || {};
window.NQP_CONFIG.APP_VERSION = window.NQP_VERSIONS[0].v;
