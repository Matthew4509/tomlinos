// Updates, done here rather than by Tauri's own updater: that one looks up the program's path through a value Tauri
// records as the program starts, and a program the installer has just started can get "not found" for it; every
// update check then failed for the rest of that session. This does the same steps without it, the same way:
//
//   1. read the update list (sheets/latest.json on GitHub, or a test build's own address);
//   2. if its version is newer than this one, offer it;
//   3. on install: download the zip it names, check it carries the update signature (the public half of the key is
//      in tauri.conf.json; anything else is refused), take the installer out of it, start it without questions
//      (/P), telling it to open the program again afterwards (/R), and close.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::time::Duration;
use tauri::api::http::{ClientBuilder, HttpRequestBuilder, ResponseType};

#[derive(Deserialize)]
struct Feed {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    platforms: HashMap<String, Platform>,
}

#[derive(Deserialize)]
struct Platform {
    signature: String,
    url: String,
}

/// A newer version on the update list: its number and what is new.
#[derive(Serialize)]
pub struct UpdateInfo {
    version: String,
    notes: String,
}

const PLATFORM: &str = "windows-x86_64";

/// Where the update list is: the address in tauri.conf.json, or in a test build (the `test-feed` feature, never
/// released) the address it was built with. Either way the download must carry the update signature.
fn feed_url(app: &tauri::AppHandle) -> Result<String, String> {
    #[cfg(feature = "test-feed")]
    if let Some(feed) = option_env!("TOMLIN_SHEETS_TEST_FEED").filter(|f| !f.is_empty()) {
        return Ok(feed.to_string());
    }
    app.config()
        .tauri
        .updater
        .endpoints
        .as_ref()
        .and_then(|list| list.first())
        .map(|u| u.to_string())
        .ok_or_else(|| "NOLIST: this copy has no update list".to_string())
}

async fn get(url: &str, wait: Duration) -> Result<Vec<u8>, String> {
    let client = ClientBuilder::new().max_redirections(10).connect_timeout(Duration::from_secs(20)).build().map_err(|e| format!("OFFLINE: {e}"))?;
    let request = HttpRequestBuilder::new("GET", url).map_err(|e| format!("OFFLINE: {e}"))?.timeout(wait).response_type(ResponseType::Binary);
    let response = client.send(request).await.map_err(|e| format!("OFFLINE: {e}"))?;
    let raw = response.bytes().await.map_err(|e| format!("OFFLINE: {e}"))?;
    if raw.status == 404 {
        return Err("NOTFOUND: the server has nothing at that address".into());
    }
    if raw.status != 200 {
        return Err(format!("OFFLINE: the server answered {}", raw.status));
    }
    Ok(raw.data)
}

async fn newer(app: &tauri::AppHandle) -> Result<Option<(Feed, semver::Version)>, String> {
    let url = feed_url(app)?;
    let body = get(&url, Duration::from_secs(30)).await?;
    let feed: Feed = serde_json::from_slice(&body).map_err(|_| "BADLIST: the update list could not be read".to_string())?;
    let theirs = semver::Version::parse(feed.version.trim_start_matches('v')).map_err(|_| "BADLIST: the update list's version is not a version number".to_string())?;
    let ours = app.package_info().version.clone();
    Ok(if theirs > ours { Some((feed, theirs)) } else { None })
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateInfo>, String> {
    Ok(newer(&app).await?.map(|(feed, v)| UpdateInfo { version: v.to_string(), notes: feed.notes.unwrap_or_default() }))
}

/// The signature check, as Tauri's own: both the key and the signature are minisign texts, written in base64.
fn verify(data: &[u8], signature_b64: &str, pubkey_b64: &str) -> Result<(), String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let text = |b64: &str| STANDARD.decode(b64).ok().and_then(|b| String::from_utf8(b).ok());
    let key = text(pubkey_b64).and_then(|t| minisign_verify::PublicKey::decode(&t).ok()).ok_or("SIGNATURE: this copy's update key could not be read")?;
    let sig = text(signature_b64).and_then(|t| minisign_verify::Signature::decode(&t).ok()).ok_or("SIGNATURE: the update's signature could not be read")?;
    key.verify(data, &sig, true).map_err(|_| "SIGNATURE: the downloaded update does not carry this program's signature".to_string())
}

/// The installer inside the downloaded zip.
fn installer_from(zip_bytes: &[u8]) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes)).map_err(|_| "BADFILE: the update could not be opened".to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|_| "BADFILE: the update could not be opened".to_string())?;
        if entry.name().to_ascii_lowercase().ends_with(".exe") && !entry.name().contains(['/', '\\']) {
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(|_| "BADFILE: the update could not be opened".to_string())?;
            return Ok(bytes);
        }
    }
    Err("BADFILE: the update holds no installer".into())
}

const FOLDER_PREFIX: &str = "TOMLIN-Sheets-update-";

/// The folders earlier updates ran their installers from. Each installer is still running when the program closes,
/// so its folder is cleared on a later start instead, half a minute in (by then the installer has finished).
pub fn clear_old_downloads() {
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_secs(30));
        let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(FOLDER_PREFIX) && entry.path().is_dir() {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    });
}

/// Downloads, checks and starts the installer, then closes this program; the installer opens it again.
#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let Some((feed, version)) = newer(&app).await? else { return Err("UPTODATE".into()) };
    let platform = feed.platforms.get(PLATFORM).ok_or("BADLIST: the update list has nothing for 64-bit Windows")?;
    let zip_bytes = get(&platform.url, Duration::from_secs(600)).await?;
    let pubkey = app.config().tauri.updater.pubkey.clone();
    verify(&zip_bytes, &platform.signature, &pubkey)?;
    let installer = installer_from(&zip_bytes)?;
    let dir = std::env::temp_dir().join(format!("{FOLDER_PREFIX}{version}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| format!("DISK: {e}"))?;
    let path = dir.join(format!("TOMLIN-Sheets-Setup-{version}.exe"));
    std::fs::write(&path, installer).map_err(|e| format!("DISK: {e}"))?;
    std::process::Command::new(&path)
        .args(["/P", "/R", "/NS", "/UPDATE", "/ARGS"])
        .current_dir(&dir)
        .spawn()
        .map_err(|e| format!("DISK: the installer could not be started ({e})"))?;
    app.exit(0);
    Ok(())
}
