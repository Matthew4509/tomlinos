# Releasing TOMLIN Sheets

TOMLIN Sheets is the TOMLIN OS spreadsheet (`src/apps/sheet.ts`, `src/apps/sheet/`) as a Windows program. Its
page is built from those same files every time, so a change to the spreadsheet reaches TOMLIN Sheets at its next
release.

## How updates reach installed copies

1. Every installed copy reads `sheets/latest.json` from this repository's `main` branch on GitHub
   (`https://raw.githubusercontent.com/Matthew4509/tomlinos/main/sheets/latest.json`), quietly a few seconds after it
   starts (at most twice a day), and whenever someone picks **File > Check for updates**.
2. If the version there is newer, it offers it with the notes from `CHANGES.md`.
3. On **Install and restart** it downloads the `.nsis.zip` that `latest.json` points at (attached to a GitHub
   release), checks it carries the TOMLIN Sheets update signature (a changed or damaged download is refused), closes,
   updates itself without questions and opens again. Other windows with unsaved work are named first.

So a release is: the update zip on a GitHub release, then `latest.json` pushed. Until `latest.json` is pushed, nobody
is offered the new version, so the files can be attached and checked first.

## Steps

1. Raise the version in **both** `sheets/src-tauri/tauri.conf.json` (`package.version`) and
   `sheets/src-tauri/Cargo.toml`, and add a `## <version>` section at the top of `sheets/CHANGES.md`.
2. From the repository folder: `node sheets/tools/release.mjs`. It builds the page and the program, signs the update,
   checks every shipped file for private details and local paths (it stops on any), copies the installer and
   the update zip into `sheets/dist/<version>/` and writes `sheets/latest.json`. It also gathers every
   part's licence (tools/licences.mjs): Help > Licences in the program, and `licences\THIRD-PARTY-NOTICES.txt`
   installed beside it.
3. On GitHub: **Releases > Draft a new release**, tag `sheets-v<version>` (exactly, the address in `latest.json` uses
   it), title `TOMLIN Sheets <version>`, attach **only** `TOMLIN-Sheets-<version>-x64.nsis.zip` (what updates
   download) from `sheets/dist/<version>/`, and publish the release.
   **Do not attach `TOMLIN-Sheets-Setup-<version>.exe`.** The installer is not published: hand it out yourself
   (email, a private link, a USB stick). Note that this keeps it unlisted, not locked: the update zip holds the
   whole program, and anyone who reads `latest.json` can find it.
4. Commit `sheets/latest.json` (with the version change) and push. Installed copies see the update from then on.

## The signing key

Updates are signed with a key kept outside every repository (`updater.key` and its password file, in the folder
`sheets/release.local.json` names as `secrets`; that file stays on the computer that makes releases and git ignores
it). Its public half is in `tauri.conf.json`. **If the key is lost, installed copies can never be updated
again** (they refuse anything not signed with it): keep a copy of that folder somewhere safe. Never commit it.

## Windows' "unknown publisher" warning

The installer is not signed with a code-signing certificate, so the first time it is downloaded Windows SmartScreen
says "Windows protected your PC" (More info > Run anyway) and the installer shows "Unknown publisher". This is the
only thing that marks it out from a big company's program. It goes away with a code-signing certificate (an
individual or organisation-validated certificate, or Microsoft's Trusted Signing service): put its thumbprint in
`tauri.conf.json` under `bundle.windows.certificateThumbprint` (with `digestAlgorithm` "sha256" and a
`timestampUrl`) and the build signs the program and installer. Updates are unaffected either way.

## Testing an update before publishing

`node sheets/tools/release.mjs --test-feed http://127.0.0.1:8790/latest.json` makes a build that reads that local
address instead of GitHub, in `sheets/dist/<version>-test/` (with its own `latest.json`). Install an older test build,
serve the newer test build's folder on that port, and use File > Check for updates. Never publish a test build.
