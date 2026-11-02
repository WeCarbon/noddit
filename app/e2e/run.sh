#!/bin/sh
# Drives the real window end to end against a throwaway project and decs home.
#   npx tauri build --debug --bundles app && sh e2e/run.sh [screenshot-dir]
# Needs a screen session; screenshots also need Screen Recording permission for the terminal.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
app="$here/../src-tauri/target/debug/bundle/macos/Noddit.app/Contents/MacOS/decs-app"
shots=${1:-}
work=$(mktemp -d "${TMPDIR:-/tmp}/decs-e2e.XXXXXX")
cleanup() {
  set +e
  [ -n "${pid:-}" ] && kill "$pid" 2>/dev/null
  # The app's monitor exits with it (--with-parent); make sure, in case the app was killed hard.
  pkill -f "monitor --updates.*--with-parent ${pid:-none}" 2>/dev/null
  [ -n "$shots" ] && cp "$work/log" "$shots/app.log" 2>/dev/null
  rm -rf "$work"
  return 0
}
trap cleanup EXIT

export NODDIT_HOME="$work/home" NODDIT_APP_DATA="$work/app" NODDIT_LANG=en NODDIT_APP_TIMING=1
# Never in front of whoever is using this Mac: no window, Dock icon, menu-bar icon, hotkey or notification.
export NODDIT_APP_BACKGROUND=${NODDIT_APP_BACKGROUND:-1}
front() { osascript -e 'tell application "System Events" to get unix id of first process whose frontmost is true' 2>/dev/null; }
front_before=$(front)
export NODDIT_BIN="${E2E_NOD:-$repo/bin/nod}" NODDIT_APP_PICK="$work/shop" NODDIT_APP_SCRIPT="$here/walkthrough.js"
mkdir -p "$NODDIT_HOME" "$NODDIT_APP_PICK" "$NODDIT_APP_DATA"
# No real notifications and no global hotkey during the run: the walkthrough sets what it tests.
printf '{"notify":"off","hotkey":"","keepInTray":true}' > "$NODDIT_APP_DATA/settings.json"
decs() { (cd "$NODDIT_APP_PICK" && NODDIT_AUTHOR="lane-db · schema" CLAUDECODE=1 "$NODDIT_BIN" "$@" >/dev/null); }
decs init --no-register
decs add "Pick a database" -o 1=SQLite 2=Postgres --body "Both work for the first year."
decs add "Write the schema" --task
decs start 2
decs add "Announce the launch" -o default:1="Post it" 2="Wait a week"
decs add "Tidy the logs" --task
decs add "Rename the bucket" -o 1=Yes 2=No
decs add "Rotate the keys" -o 1=Now 2=Later
decs add "Weekly report is ready" --body "Nothing unusual this week."

"$app" > "$work/log" 2>&1 &
pid=$!
seen=0
status=1
for _ in $(seq 1 1500); do
  sleep 0.2
  lines=$(grep -c . "$work/log" || true)
  [ "$lines" -gt "$seen" ] || continue
  sed -n "$((seen + 1)),${lines}p" "$work/log" | while IFS= read -r line; do
    echo "$line"
    case "$line" in
      *"SHOT "*)
        if [ -n "$shots" ]; then
          set -- $(echo "$line" | sed 's/.*SHOT //')
          mkdir -p "$shots"
          screencapture -x -R "$2,$3,$4,$5" "$shots/$1.png" || true
        fi ;;
    esac
  done
  seen=$lines
  # By process id: an installed copy of the app has the same name and may be in use.
  [ "$NODDIT_APP_BACKGROUND" = 1 ] && [ "$(front)" = "$pid" ] && echo "frontmost" >> "$work/front"
  if [ -z "${filed:-}" ] && grep -q "decs-app: STEP announce" "$work/log"; then
    # A decision filed while the app runs must reach the bench and be announced.
    decs add "Pick a CDN" -o 1=Keep 2=Switch
    filed=1
  fi
  if grep -q "decs-app: DONE" "$work/log"; then
    grep -q "announce X8" "$work/log" && status=0
    break
  fi
  if grep -q "decs-app: FAIL" "$work/log"; then sleep 2; break; fi
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
if grep -q "MAIN THREAD BLOCKED" "$work/log"; then
  echo "e2e: the main thread was blocked (see the log)" >&2
  status=1
fi
# Whoever is at the keyboard may switch apps meanwhile; what must never happen is this app in front.
if [ "$NODDIT_APP_BACKGROUND" = 1 ] && grep -q "frontmost" "$work/front" 2>/dev/null; then
  echo "e2e: the app came to the front during the run" >&2
  status=1
fi

if [ "$status" -eq 0 ]; then
  cd "$NODDIT_APP_PICK"
  check() { "$NODDIT_BIN" get "$1" --json | CHECK="$2" node -e 'const d = JSON.parse(require("fs").readFileSync(0)); if (!eval(process.env.CHECK)) { console.error("check failed on " + process.argv[1] + ": " + process.env.CHECK + " — " + JSON.stringify({ title: d.title, status: d.status, pin: d.pin, notes: d.notes.map((n) => n.kind) })); process.exit(1) }' "$1"; }
  check 1 "d.answer.choice==='2' && /JSON columns/.test(d.answer.note) && d.answer.by==='owner'"
  check 3 "d.answer.choice==='2' && d.notes.filter((n) => n.kind === '已答').length === 2"
  check 2 "d.notes.some(n=>n.role==='human' && /索引/.test(n.text))"
  check 2 "d.important === true && d.milestone === true && /^2030-01-15T23:59:59/.test(d.due)"
  check 4 "d.deferred_at"
  check 5 "d.pin === 'top'"
  check 6 "d.status === 'closed' && d.close_reason === 'merged into X5'"
  check 7 "d.status === 'completed'"
  check 1 "d.project_name === 'Shop front' && d.ref === 'Q1'"
  check X1 "d.ref === 'Q1'"
  if grep -q "STEP brief$" "$work/log"; then
    check 9 "d.intake === true && d.brief === 'unclaimed' && d.original === 'Add rate limits to the export endpoint'"
  fi
  # Unlinked: out of the registry, folder and files untouched.
  ! grep -q '"root"' "$NODDIT_HOME/config.json"
  [ -f "$NODDIT_APP_PICK/decisions/decs.json" ]
  echo "e2e: all checks passed"
fi
exit "$status"
