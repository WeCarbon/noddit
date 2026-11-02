mod noddit_env;
mod resize;
mod watch;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Manager, State, WindowEvent};
use tokio::process::Command;

const NPM_PACKAGE: &str = "@wecarbon/decisions-md";

pub(crate) struct AppState {
    started: Instant,
    #[cfg(debug_assertions)]
    script_ran: std::sync::atomic::AtomicBool,
    env: Mutex<Option<ShellEnv>>,
    pub(crate) monitor: Mutex<Option<u32>>,
}

/// What a login shell would find. A GUI app starts with launchd's bare PATH,
/// so `node` and `decs` are looked up the way the owner's terminal does.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct ShellEnv {
    path: String,
    node: Option<String>,
    node_version: Option<String>,
    npm: Option<String>,
    pub(crate) decs: Option<String>,
    decs_version: Option<String>,
}

#[derive(Serialize)]
struct RunOutput {
    code: i32,
    stdout: String,
    stderr: String,
}

/// `NODDIT_APP_DATA` (or the older `DECS_APP_DATA`) points the app's own state (prefs, cached
/// bench) elsewhere — a second profile, or a test run.
/// `NODDIT_APP_BACKGROUND=1` (or `DECS_APP_BACKGROUND`) — for scripted runs on a machine someone
/// is using: the app never comes to the front, never shows or focuses a window, has no Dock icon,
/// menu-bar icon, global hotkey or real notifications. Everything else — the CLI calls, the
/// monitor, the page — runs as usual.
pub(crate) fn background() -> bool {
    noddit_env::var("APP_BACKGROUND").map(|v| !v.is_empty() && v != "0").unwrap_or(false)
}

pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = noddit_env::var_os("APP_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("decs-app")));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// The identifier the app had before it was renamed: its data directory sat next to this one.
const FORMER_IDENTIFIER: &str = "com.wecarbon.decs";

/// First launch under the new identifier: bring prefs, settings and the cached bench over from the old
/// data directory, so a rename does not reset anyone's setup. Never overwrites, never deletes the old one.
fn migrate_former_data(app: &AppHandle) {
    if noddit_env::is_set("APP_DATA") {
        return;
    }
    let Ok(dir) = app.path().app_data_dir() else { return };
    let Some(old) = dir.parent().map(|p| p.join(FORMER_IDENTIFIER)) else { return };
    if old == dir || !old.is_dir() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    // Not env.json: where node and decs live is probed again rather than trusted from before.
    for name in ["settings.json", "prefs.json", "bench.json"] {
        let (from, to) = (old.join(name), dir.join(name));
        if from.is_file() && !to.exists() {
            let _ = std::fs::copy(from, to);
        }
    }
}

fn login_path() -> String {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let out = std::process::Command::new(shell)
        .args(["-ilc", "printf '\\n__DECS_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output();
    let found = out.ok().and_then(|o| {
        String::from_utf8_lossy(&o.stdout)
            .lines()
            .find_map(|l| l.strip_prefix("__DECS_PATH__").map(str::to_string))
    });
    let base = std::env::var("PATH").unwrap_or_default();
    let extra = "/opt/homebrew/bin:/usr/local/bin";
    match found {
        Some(p) if !p.is_empty() => format!("{p}:{extra}:{base}"),
        _ => format!("{extra}:{base}"),
    }
}

fn which(name: &str, path: &str) -> Option<String> {
    std::env::split_paths(path)
        .map(|d| d.join(name))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn first_line(cmd: &str, args: &[&str], path: &str) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).env("PATH", path).stdin(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().next().map(|s| s.trim().to_string())
}

fn probe() -> ShellEnv {
    let path = login_path();
    // Prefer `nod` (the current name); fall back to `decs` for older installs
    // that only have the alias on PATH.
    let decs = noddit_env::var("BIN")
        .filter(|p| !p.is_empty())
        .or_else(|| which("nod", &path))
        .or_else(|| which("decs", &path));
    let node = which("node", &path);
    ShellEnv {
        node_version: node.as_ref().and_then(|n| first_line(n, &["--version"], &path)),
        decs_version: decs.as_ref().and_then(|d| first_line(d, &["--version"], &path)),
        npm: which("npm", &path),
        node,
        decs,
        path,
    }
}

fn env_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("env.json")
}

fn cached_env(app: &AppHandle, state: &AppState) -> Option<ShellEnv> {
    if let Some(e) = state.env.lock().unwrap().clone() {
        return Some(e);
    }
    let text = std::fs::read_to_string(env_file(app)).ok()?;
    let env: ShellEnv = serde_json::from_str(&text).ok()?;
    let still_there = env.decs.as_ref().map(|d| PathBuf::from(d).is_file()).unwrap_or(false);
    if !still_there {
        return None;
    }
    *state.env.lock().unwrap() = Some(env.clone());
    Some(env)
}

fn refresh_env(app: &AppHandle, state: &AppState) -> ShellEnv {
    let env = probe();
    if let Ok(text) = serde_json::to_string(&env) {
        let _ = std::fs::write(env_file(app), text);
    }
    *state.env.lock().unwrap() = Some(env.clone());
    env
}

/// The environment decs runs in, probing the login shell only when nothing is cached.
pub(crate) fn env_now(app: &AppHandle) -> Option<ShellEnv> {
    let state = app.state::<AppState>();
    cached_env(app, &state).or_else(|| Some(refresh_env(app, &state)))
}

#[tauri::command]
async fn shell_env(app: AppHandle, state: State<'_, AppState>, refresh: bool) -> Result<ShellEnv, String> {
    if !refresh {
        if let Some(e) = cached_env(&app, &state) {
            return Ok(e);
        }
    }
    Ok(refresh_env(&app, &state))
}

pub(crate) fn decs_command(env: &ShellEnv, args: &[String], cwd: Option<&str>) -> Result<Command, String> {
    let bin = env.decs.clone().ok_or("nod is not installed")?;
    let mut cmd = Command::new(bin);
    cmd.args(args).env("PATH", &env.path).env("NO_COLOR", "1").env_remove("CLAUDECODE");
    noddit_env::remove(&mut cmd, "ROLE");
    cmd.stdin(Stdio::null());
    // Never the app's own working directory: decs would fall back to whatever project that happens to be in.
    match cwd.map(PathBuf::from).or_else(|| std::env::var_os("HOME").map(PathBuf::from)) {
        Some(dir) => {
            cmd.current_dir(dir);
        }
        None => {}
    }
    Ok(cmd)
}

#[tauri::command]
async fn decs(app: AppHandle, state: State<'_, AppState>, args: Vec<String>, cwd: Option<String>, stdin: Option<String>) -> Result<RunOutput, String> {
    let env = cached_env(&app, &state).unwrap_or_else(|| refresh_env(&app, &state));
    let mut args = args;
    // In background (test) mode nothing opens a terminal: the CLI only reports what it would run.
    if background() && args.len() >= 2 && args[0] == "session" && args[1] == "start" && !args.iter().any(|a| a == "--dry-run") {
        args.push("--dry-run".into());
    }
    let mut cmd = decs_command(&env, &args, cwd.as_deref())?;
    let out = match stdin {
        Some(text) => {
            use tokio::io::AsyncWriteExt;
            cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = cmd.spawn().map_err(|e| e.to_string())?;
            if let Some(mut pipe) = child.stdin.take() {
                pipe.write_all(text.as_bytes()).await.map_err(|e| e.to_string())?;
            }
            child.wait_with_output().await.map_err(|e| e.to_string())?
        }
        None => cmd.output().await.map_err(|e| e.to_string())?,
    };
    Ok(RunOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

/// Starts the watch if it is not running yet (after onboarding installed or found decs).
#[tauri::command]
async fn monitor_start(app: AppHandle) -> Result<(), String> {
    watch::start_monitor(&app);
    Ok(())
}

#[tauri::command]
fn snapshot_load(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(data_dir(&app).join("bench.json")).ok()
}

#[tauri::command]
fn snapshot_save(app: AppHandle, json: String) -> Result<(), String> {
    let dir = data_dir(&app);
    let tmp = dir.join("bench.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, dir.join("bench.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn prefs_load(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(data_dir(&app).join("prefs.json")).ok()
}

#[tauri::command]
fn prefs_save(app: AppHandle, json: String) -> Result<(), String> {
    std::fs::write(data_dir(&app).join("prefs.json"), json).map_err(|e| e.to_string())
}

/// The window stays hidden until the first frame is drawn, so it never flashes blank.
#[tauri::command]
fn ready(app: AppHandle, state: State<'_, AppState>, what: String) -> u128 {
    if let Some(w) = app.get_webview_window("main") {
        if !background() {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let ms = state.started.elapsed().as_millis();
    if noddit_env::is_set("APP_TIMING") {
        eprintln!("decs-app: {what} {ms} ms after launch");
    }
    #[cfg(debug_assertions)]
    run_script_once(&app, &state);
    ms
}

/// Debug builds only: `NODDIT_APP_SCRIPT=<file.js>` (or the older `DECS_APP_SCRIPT`) runs that file
/// in the page once it is up — how the window is driven end to end without anyone clicking.
#[cfg(debug_assertions)]
fn run_script_once(app: &AppHandle, state: &AppState) {
    use std::sync::atomic::Ordering;
    if state.script_ran.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(path) = noddit_env::var_os("APP_SCRIPT") else { return };
    match (std::fs::read_to_string(&path), app.get_webview_window("main")) {
        (Ok(js), Some(w)) => {
            let _ = w.eval(&js);
        }
        (Err(e), _) => eprintln!("decs-app: APP_SCRIPT: {e}"),
        _ => {}
    }
}

/// A `SHOT <name> x y w h` line (window bounds in points) for the e2e runner to capture.
#[tauri::command]
fn e2e_shot(app: AppHandle, name: String) {
    if let Some(w) = app.get_webview_window("main") {
        let scale = w.scale_factor().unwrap_or(1.0);
        if let (Ok(p), Ok(s)) = (w.outer_position(), w.outer_size()) {
            let (p, s) = (p.to_logical::<f64>(scale), s.to_logical::<f64>(scale));
            eprintln!("decs-app: SHOT {name} {} {} {} {}", p.x, p.y, s.width, s.height);
        }
    }
}

/// The folder picker. `NODDIT_APP_PICK` (or the older `DECS_APP_PICK`) answers it without a dialog, for scripted runs.
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    if let Some(dir) = noddit_env::var("APP_PICK") {
        return Some(dir);
    }
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked.and_then(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()));
    });
    rx.await.ok().flatten()
}

/// Debug builds keep the web view's own menu (Inspect Element) on ⌥-right-click; release builds never show it.
#[tauri::command]
fn is_debug() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn is_background() -> bool {
    background()
}

/// Errors the page hits, on the app's stderr: the window has no console in a release build.
#[tauri::command]
fn log(line: String) {
    eprintln!("decs-app: {line}");
}

#[tauri::command]
async fn install_decs(app: AppHandle, state: State<'_, AppState>) -> Result<RunOutput, String> {
    let env = refresh_env(&app, &state);
    let npm = env.npm.clone().ok_or("npm is not installed")?;
    let out = Command::new(npm)
        .args(["install", "-g", NPM_PACKAGE])
        .env("PATH", &env.path)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    refresh_env(&app, &state);
    Ok(RunOutput {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    })
}

pub fn run() {
    let started = Instant::now();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(|app, _, event| watch::on_hotkey(app, event.state)).build())
        .manage(watch::Watch::default())
        .manage(resize::ResizeStart::default())
        .manage(AppState {
            started,
            #[cfg(debug_assertions)]
            script_ran: Default::default(),
            env: Mutex::new(None),
            monitor: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            shell_env,
            decs,
            monitor_start,
            snapshot_load,
            snapshot_save,
            prefs_load,
            prefs_save,
            ready,
            install_decs,
            log,
            is_debug,
            is_background,
            resize::resize_begin,
            resize::resize_to,
            pick_folder,
            e2e_shot,
            watch::settings_get,
            watch::settings_set,
            watch::set_phrases,
            watch::waiting_get,
            watch::banner_hide,
            watch::banner_open_main,
            watch::summoned,
            watch::press_hotkey
        ])
        .on_window_event(|window, event| {
            // Closing the window keeps decs in the menu bar / tray; Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                let quitting = app.state::<watch::Watch>().quitting.load(Ordering::SeqCst);
                if window.label() == "banner" || (!quitting && watch::settings(app).keep_in_tray) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            migrate_former_data(app.handle());
            #[cfg(target_os = "macos")]
            if background() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            watch::init(app.handle());
            // Shown by `ready` once the first frame is drawn; this is only the fallback if the page never says so.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
                if let Some(w) = handle.get_webview_window("main") {
                    if !background() && !w.is_visible().unwrap_or(true) {
                        let _ = w.show();
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building decs")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                watch::stop_monitor(app);
            }
        });
}
