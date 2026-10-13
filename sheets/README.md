# TOMLIN Sheets

The TOMLIN OS spreadsheet as a Windows 10 and 11 program of its own: an installer with Start menu and desktop
shortcuts, an uninstaller in Settings > Apps, one window per workbook, Windows' own Open and Save boxes, recent
files, printing, and updates from within the program.

It is built from the same spreadsheet files TOMLIN OS uses (`src/apps/sheet.ts`, `src/apps/sheet/`); only the
host around it is its own:

| Part | What it does |
|---|---|
| `host/` | The page side: windows, Open/Save boxes, recent files, "save changes?" on close, updates, About |
| `host/files.ts` | The computer's real files in the shape the spreadsheet already uses |
| `src-tauri/` | The Windows program (Rust, Tauri 1, WebView2): file reads and safe writes, settings, the installer |
| `page/` | The page and its Windows 11 style layer (`sheets.css`, after TOMLIN OS's `style.css`) |
| `tools/build-web.mjs` | Builds `web/` from `host/main.ts` and exactly the TOMLIN OS files it needs |
| `tools/release.mjs` | A release: build, sign the update, check for private details, write `latest.json` |
| `tools/make-art.mjs` | Draws the icon and the installer's pictures |
| `test/app-walk.mjs` | Drives the installed program itself through a walk-through |
| `latest.json` | The update list installed copies read from GitHub |

Inside TOMLIN OS nothing changes: the spreadsheet only behaves differently when `shell.native` is set
(`src/shell/native.ts`), which only this host does.

## Building

Needs Node 22.13 or newer, Rust (MSVC) and the Tauri 1 command line (`cargo install tauri-cli --version "^1"`).
From the repository folder:

- `node sheets/tools/build-web.mjs`, then open `sheets/web/` with any local web server for a quick look in a browser
  (files and Open/Save need the program);
- `node sheets/tools/release.mjs` for the installer (see RELEASING.md).

## What it opens

Excel workbooks (.xlsx, saved back as .xlsx), .xlsm (opened without macros, saved as a new file), its own .sheet
files (which keep PivotTables live), and .csv/.tsv/.txt. Old .xls files and password-protected workbooks are
refused with the reason and the way out. Limits are the spreadsheet's own: 5,000 rows by 256 columns a sheet.
