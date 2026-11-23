// Version history, newest first. The first entry is the running version.
// Rule: ask Chongyin before changing the version number. Notes: one short line per change, no details.
window.NQP_VERSIONS = [
  {v: '0.4.1', date: '2026-11-23', notes: ['Neware Cycling: Export Excel, one sheet for each plot', 'Sign-in no longer waits for the data folder']},
  {v: '0.4.0', date: '2026-11-23', notes: ['Smart search: find cells by description (Ni65 graphite with VC) in the cell trackers and file names']},
  {v: '0.3.3', date: '2026-11-20', notes: ['Combined PNG', 'Tick boxes to hide cells', 'EIS ECM: Excel export']},
  {v: '0.3.2', date: '2026-11-15', notes: ['Charge–discharge curves', 'Clear all']},
  {v: '0.3.1', date: '2026-11-13', notes: ['New tabs: NMC XPS, EIS ECM, EIS DRT', 'Neware Cycling: automatic redraw, new layout, crosshair', 'Every tab remembers its last state', 'Raman Fitting: two-step background, resizable plots']},
  {v: '0.2.3', date: '2026-11-12', notes: ['File index built on the office PC: cells load without reading folders']},
  {v: '0.2.2', date: '2026-11-12', notes: ['Faster file lookup', 'Barcode ranges', 'File-name search', 'Cell details']},
  {v: '0.2.1', date: '2026-11-12', notes: ['Tabs: Neware Cycling and Raman Fitting']},
  {v: '0.1.2', date: '2026-11-08', notes: ['ΔV plot modes', 'Last-cycle % on normalized plots']},
  {v: '0.1.1', date: '2026-11-08', notes: ['Web version with sign-in', 'Feedback']},
  {v: '0.1.0', date: '2026-11-08', notes: ['First version']},
];
window.NQP_CONFIG = window.NQP_CONFIG || {};
window.NQP_CONFIG.APP_VERSION = window.NQP_VERSIONS[0].v;
