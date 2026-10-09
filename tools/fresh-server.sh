#!/usr/bin/env bash
# Starts the PHP dev server for the browser tests on a NEW empty data folder each time (old folders hid faults before).
#   bash tools/fresh-server.sh [port] [parent-folder]
# Prints the data folder it chose, then runs the server in the foreground. Stop it with Ctrl+C (or kill the process).
set -euo pipefail
PORT="${1:-3043}"
PARENT="${2:-${TMPDIR:-/tmp}}"
PHP="${PHP_BIN:-php}"
export PHP_BIN="$PHP"
# Mail and the Reader's library need openssl (and mbstring for mail headers). A portable Windows PHP has them in ext/ but not
# switched on in its shared php.ini, and has no CA list of its own; pass both here rather than editing that php.ini.
PHPDIR="$(dirname "$PHP")"
PHP_FLAGS=""
[ -f "$PHPDIR/ext/php_openssl.dll" ] && PHP_FLAGS="-d extension_dir=$PHPDIR/ext -d extension=openssl -d extension=mbstring -d extension=curl -d openssl.cafile=$PHPDIR/extras/cacert.pem"
DATA="$PARENT/tomlinos-test-$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$DATA"
echo "data folder: $DATA"
cd "$(dirname "$0")/.."
DESKTOP_DATA_DIR="$DATA" exec "$PHP" $PHP_FLAGS -d post_max_size=300M -d upload_max_filesize=300M -S "127.0.0.1:$PORT" -t out server/dev-router.php
