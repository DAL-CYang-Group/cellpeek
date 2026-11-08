# CellPeek

A small web tool for looking at Neware battery-cycling exports: discharge capacity, normalized capacity,
Coulombic efficiency and ΔV against cycle number or time, plus dQ/dV, for several cells at once.
Plots can be exported as PNG figures.

Made by [Chongyin Yang](https://www.yang-dal.com/) (Dalhousie University). Access needs approval.

## How it works

- Runs in **Chrome or Edge**. On first use you choose the `CYCLING` data folder on your computer
  (e.g. `Z:\databdayse\DATA\CYCLING`). The page opens it **read-only** and remembers it in this browser.
- Files are parsed in your browser (`parser.js`, in a background thread) and cached locally. No data leave your computer.
- Sign-in, approval, usage counts and feedback go to a Google Apps Script backend (address in `config.js`).

## Files

| file | what |
|---|---|
| `index.html` | page and plotting |
| `config.js` | backend address |
| `versions.js` | version number and history (newest first) |
| `data.js` | reads the data folder (or the office server for super users) |
| `parser.js` | Neware export parser (old and new formats) |
| `auth.js` | sign-in, approval, feedback, usage log |
| `static/` | [uPlot](https://github.com/leeoniya/uPlot) 1.6.31, MIT licence |

## Publishing a new version

1. Change the files; add a new entry at the top of `versions.js` (bump the last number for small fixes; the first two numbers only with Chongyin's approval).
2. Commit and push (GitHub Pages updates in about a minute).
3. Set `LATEST_VERSION` in the Google Sheet `config` tab to the same number; open pages then show "new version available".
