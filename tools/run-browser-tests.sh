#!/usr/bin/env bash
# Runs all eight browser suites, ONE AFTER ANOTHER, each against its own PHP server on a NEW empty data folder, and
# prints a summary. Exits 1 if any suite failed or stopped before its summary line. Needs `npm run build` first.
# (Running them all at once can overload a computer and fail steps at random; one at a time, a red result means
# something. Takes about 20 minutes.)
#   bash tools/run-browser-tests.sh [parent-folder-for-data]
set -uo pipefail
cd "$(dirname "$0")/.."
PARENT="${1:-${TMPDIR:-/tmp}}"
PHP="${PHP_BIN:-php}"
export PHP_BIN="$PHP"
# Mail and the Reader's library need openssl (and mbstring for mail headers). A portable Windows PHP has them in ext/ but not
# switched on in its shared php.ini, and has no CA list of its own; pass both here rather than editing that php.ini.
PHPDIR="$(dirname "$PHP")"
PHP_FLAGS=""
[ -f "$PHPDIR/ext/php_openssl.dll" ] && PHP_FLAGS="-d extension_dir=$PHPDIR/ext -d extension=openssl -d extension=mbstring -d extension=curl -d openssl.cafile=$PHPDIR/extras/cacert.pem"
LOGS="$PARENT/tomlinos-browser-logs-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$LOGS"
PORT=3043
# Two runs at once share this port and fail each other at random (a stopped run can keep going underneath).
if netstat -ano 2>/dev/null | grep -qE "[:.]$PORT +.*LISTEN"; then
  echo "Port $PORT is already in use: another test run (or its server) is still going. Stop it first:"
  echo "  ps -ef | grep run-browser-tests   and   netstat -ano | grep :$PORT"
  exit 2
fi
status=0
for suite in desktop accounts vault features apps printer privacy aichat; do
  DATA="$PARENT/tomlinos-test-$(date +%Y%m%d-%H%M%S)-$suite"
  mkdir -p "$DATA" "$DATA-models"
  # Model saves follow pinned versions: the stand-in for Hugging Face comes with its own pins.
  node -e "import('./test/fake-huggingface.mjs').then(m => m.writeStandInPins(process.argv[1]))" "$DATA-pins.json"
  # The Mail steps talk to a stand-in mail server on 127.0.0.1 (test/fake-mail.mjs); only these two addresses, and
  # only in this test run, may be reached unencrypted. The Claude step talks to a stand-in for Anthropic
  # (test/fake-anthropic.mjs) the same way: nothing leaves this computer.
  DESKTOP_MAIL_ALLOW_HOSTS=127.0.0.1:3143,127.0.0.1:3587 DESKTOP_MAIL_ALLOW_PLAIN=1 DESKTOP_AI_TEST_URL=http://127.0.0.1:3190 DESKTOP_MODELS_TEST_URL=http://127.0.0.1:3191 DESKTOP_MODELS_TEST_PINS="$DATA-pins.json" DESKTOP_MODELS_DIR="$DATA-models" DESKTOP_DATA_DIR="$DATA" "$PHP" $PHP_FLAGS -d post_max_size=300M -d upload_max_filesize=300M -S "127.0.0.1:$PORT" -t out server/dev-router.php >/dev/null 2>&1 &
  server=$!
  sleep 1
  case $suite in
    desktop) script=test/browser.mjs; extra=() ;;
    vault) script=test/browser-vault.mjs; extra=("$DATA") ;;
    privacy) script=test/browser-privacy.mjs; extra=("$DATA" "$DATA-models") ;;
    apps) script=test/browser-apps.mjs; extra=() ;;
    *) script=test/browser-$suite.mjs; extra=() ;;
  esac
  node "$script" "http://127.0.0.1:$PORT" "${extra[@]}" > "$LOGS/$suite.txt" 2>&1 || status=1
  kill "$server" 2>/dev/null
  wait "$server" 2>/dev/null
  summary=$(grep -E 'passed, ' "$LOGS/$suite.txt" | tail -1)
  if [ -z "$summary" ]; then
    summary="STOPPED before its summary (see the log)"
    status=1
  fi
  echo "== $suite: $summary"
  grep -E '^  FAIL|^       ' "$LOGS/$suite.txt" | head -20
  sleep 1
done
echo "logs: $LOGS"
exit $status
