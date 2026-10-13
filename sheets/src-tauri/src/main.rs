// TOMLIN Sheets: the TOMLIN OS spreadsheet as a Windows program of its own. The window shows the same spreadsheet
// code; this side gives it the computer's real files (read, written safely, and refused in plain words), a folder
// for its settings, and a WebView2 set up as a program rather than a browser (no browser keys, zoom or status bar).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod update;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

/// A file or folder as the spreadsheet sees it. `id` changes whenever the file is written, by anyone.
#[derive(Serialize)]
struct Stat {
    name: String,
    kind: &'static str,
    size: u64,
    modified: f64,
    id: String,
}

fn stat_of(path: &Path, meta: &fs::Metadata) -> Stat {
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    let size = if meta.is_dir() { 0 } else { meta.len() };
    Stat {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: if meta.is_dir() { "folder" } else { "file" },
        size,
        modified,
        id: format!("{}:{}", modified as u64, size),
    }
}

fn name_of(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

/// What went wrong, why, and what to do, for the person (never an error code on its own).
fn words(err: &io::Error, path: &Path, doing: &str) -> String {
    let name = name_of(path);
    match err.raw_os_error() {
        // Sharing and lock violations: another program (often Excel) has the file open.
        Some(32) | Some(33) => {
            return format!("“{name}” is open in another program, which is keeping it locked. Close it there and try again, or use Save as to save under another name.")
        }
        Some(112) | Some(39) => {
            return format!("There is not enough space on the drive to {doing} “{name}”. Free some space, or save it somewhere else.")
        }
        _ => {}
    }
    match err.kind() {
        io::ErrorKind::NotFound => format!("“{name}” is not there any more. It may have been moved, renamed or deleted, or its drive may be unplugged."),
        io::ErrorKind::PermissionDenied => format!("Windows did not allow this program to {doing} “{name}”. The file may be read-only, or the folder may need permission this program does not have. Try another folder, such as Documents."),
        _ => format!("Windows could not {doing} “{name}” ({err}). Nothing else was changed. Try again, or choose another folder."),
    }
}

/// The file the program was started with (a double-click on a file, "Open with", or a path typed after the program's
/// name), made a whole path before the program changes its current folder (see main).
static LAUNCH: OnceLock<Option<PathBuf>> = OnceLock::new();

fn find_launch_file() -> Option<PathBuf> {
    std::env::args_os().skip(1).map(PathBuf::from).find(|p| p.is_file()).and_then(|p| fs::canonicalize(&p).ok().or(Some(p)))
}

/// Handed out once: a window opened later starts empty or with the file it was opened for.
#[tauri::command]
fn launch_file() -> Option<String> {
    static TAKEN: AtomicBool = AtomicBool::new(false);
    if TAKEN.swap(true, Ordering::SeqCst) {
        return None;
    }
    LAUNCH.get().cloned().flatten().map(|p| {
        let shown = p.display().to_string();
        // canonicalize writes "\\?\C:\..."; the page wants the everyday form.
        shown
            .strip_prefix(r"\\?\UNC\")
            .map(|rest| format!(r"\\{rest}"))
            .or_else(|| shown.strip_prefix(r"\\?\").map(str::to_string))
            .unwrap_or(shown)
    })
}

#[tauri::command]
fn stat(path: String) -> Option<Stat> {
    let p = PathBuf::from(&path);
    fs::metadata(&p).ok().map(|m| stat_of(&p, &m))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    fs::read(&p).map(|bytes| STANDARD.encode(bytes)).map_err(|e| words(&e, &p, "open"))
}

/// Writes the whole file next to the old one first, then swaps it in, so a failed save never leaves half a file.
/// With `replacing`, the file must still be the copy that was opened; otherwise nothing is written and the answer
/// starts with "CHANGED:" and the id of the copy there now.
#[tauri::command]
fn write_file(path: String, data: String, replacing: Option<String>) -> Result<Stat, String> {
    let p = PathBuf::from(&path);
    let bytes = STANDARD.decode(data.as_bytes()).map_err(|_| "The program could not prepare the file to save. Nothing was written.".to_string())?;
    if let Some(expect) = replacing.filter(|s| !s.is_empty()) {
        if let Ok(meta) = fs::metadata(&p) {
            let now = stat_of(&p, &meta);
            if now.id != expect {
                return Err(format!("CHANGED:{}", now.id));
            }
        }
    }
    let dir = p.parent().ok_or_else(|| format!("“{}” is not a place a file can be saved.", p.display()))?;
    let temp = dir.join(format!(".{}.saving-{}.tmp", name_of(&p), std::process::id()));
    if let Err(e) = fs::write(&temp, &bytes) {
        let _ = fs::remove_file(&temp);
        return Err(words(&e, &p, "save"));
    }
    if let Err(e) = fs::rename(&temp, &p) {
        let _ = fs::remove_file(&temp);
        // Replacing a file another program holds open is refused as "access denied": said as what it is.
        if e.kind() == io::ErrorKind::PermissionDenied && held_open(&p) {
            return Err(words(&io::Error::from_raw_os_error(32), &p, "save"));
        }
        return Err(words(&e, &p, "save"));
    }
    let meta = fs::metadata(&p).map_err(|e| words(&e, &p, "save"))?;
    Ok(stat_of(&p, &meta))
}

/// True when another program has the file open in a way that stops it being written (Excel does, while it is open).
fn held_open(path: &Path) -> bool {
    match fs::OpenOptions::new().write(true).open(path) {
        Ok(_) => false,
        Err(e) => matches!(e.raw_os_error(), Some(32) | Some(33)),
    }
}

#[tauri::command]
fn list(path: String) -> Result<Vec<Stat>, String> {
    let p = PathBuf::from(&path);
    let entries = fs::read_dir(&p).map_err(|e| words(&e, &p, "open the folder"))?;
    Ok(entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.metadata().ok().map(|m| stat_of(&e.path(), &m)))
        .collect())
}

/// Settings are small named files in the program's own folder under the person's AppData.
fn setting_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_') || name.starts_with('.') {
        return Err("That is not a setting this program keeps.".into());
    }
    let dir = app.path_resolver().app_config_dir().ok_or("Windows did not say where this person's settings are kept.")?;
    fs::create_dir_all(&dir).map_err(|e| words(&e, &dir, "make the settings folder"))?;
    Ok(dir.join(name))
}

#[tauri::command]
fn read_setting(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let p = setting_path(&app, &name)?;
    match fs::read_to_string(&p) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(words(&e, &p, "read the setting")),
    }
}

#[tauri::command]
fn write_setting(app: tauri::AppHandle, name: String, text: String) -> Result<(), String> {
    let p = setting_path(&app, &name)?;
    let temp = p.with_extension("tmp");
    fs::write(&temp, text).and_then(|_| fs::rename(&temp, &p)).map_err(|e| words(&e, &p, "keep the setting"))
}

/// A program, not a browser: the browser's own keys (reload, find, zoom, developer tools...), its zoom and its
/// link status bar are switched off. Editing keys (copy, paste, undo) are not browser keys and keep working.
#[cfg(windows)]
fn harden(window: &tauri::Window) {
    let _ = window.with_webview(|webview| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
        use windows::core::Interface;
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let Ok(settings) = core.Settings() else { return };
        let _ = settings.SetIsStatusBarEnabled(false);
        let _ = settings.SetIsZoomControlEnabled(false);
        if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
            let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
        }
    });
}

#[cfg(not(windows))]
fn harden(_window: &tauri::Window) {}

fn main() {
    // The file named on the command line is read first; then the current folder becomes the program's own (a program
    // the installer starts again after an update otherwise begins in the installer's temporary folder).
    let _ = LAUNCH.set(find_launch_file());
    if let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) {
        let _ = std::env::set_current_dir(dir);
    }
    update::clear_old_downloads();
    tauri::Builder::default()
        .on_page_load(|window, _| harden(&window))
        .invoke_handler(tauri::generate_handler![launch_file, stat, read_file, write_file, list, read_setting, write_setting, update::update_check, update::update_install])
        .run(tauri::generate_context!())
        .expect("TOMLIN Sheets could not start");
}
