//! What keeps running when the window is closed: the menu-bar / tray icon with the
//! decisions waiting on the owner, notifications when a new one arrives, the banner
//! window, and the global hotkey that brings the most urgent one up.
//!
//! Everything comes from the CLI: `decs monitor --updates` says something changed,
//! `decs show --json` says what is waiting now.

use crate::{background, data_dir, decs_command, env_now, noddit_env, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tokio::io::{AsyncBufReadExt, BufReader};

const TRAY_ITEMS: usize = 5;
const BANNER_WIDTH: f64 = 400.0;
const BANNER_HEIGHT: f64 = 236.0;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// `system` (the OS notification), `banner` (the app's own window), or `off`.
    pub notify: String,
    pub hotkey: String,
    /// Closing the window leaves the app running in the menu bar / tray.
    pub keep_in_tray: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { notify: "system".into(), hotkey: default_hotkey(), keep_in_tray: true }
    }
}

/// ⌃Space is the input-source switch for many people who type CJK; take ⌃⌥Space then.
pub fn default_hotkey() -> String {
    if ctrl_space_switches_input() { "Ctrl+Alt+Space".into() } else { "Ctrl+Space".into() }
}

#[cfg(target_os = "macos")]
pub fn ctrl_space_switches_input() -> bool {
    let Ok(out) = std::process::Command::new("defaults")
        .args(["read", "com.apple.symbolichotkeys", "AppleSymbolicHotKeys"])
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    // Hotkey 60 is "Select the previous input source"; 49 is Space, 262144 the Control mask.
    let Some(at) = text.find("\n        60 =").or_else(|| text.find(" 60 =")) else { return false };
    let block: String = text[at..].chars().take(400).collect();
    let block = block.split("};\n    ").next().unwrap_or(&block).to_string();
    block.contains("enabled = 1") && block.contains("49,") && block.contains("262144")
}

#[cfg(not(target_os = "macos"))]
pub fn ctrl_space_switches_input() -> bool {
    false
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Opt {
    key: String,
    label: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Waiting {
    key: String,
    id: u64,
    #[serde(rename = "ref")]
    reference: String,
    project: String,
    title: String,
    root: String,
    options: Vec<Opt>,
    default: Option<String>,
    urgent: bool,
}

/// A live node the owner marked as a milestone (`nod flag … milestone`).
#[derive(Clone, Serialize)]
pub struct Milestone {
    key: String,
    #[serde(rename = "ref")]
    reference: String,
    title: String,
    /// Milliseconds since the epoch.
    due: i64,
}

/// Words the notifications use, in the window's language (it knows it; this side does not).
#[derive(Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Phrases {
    needs_decision: String,
    not_collected: String,
    /// "Milestone in a day" / "Milestone in an hour" / "Milestone".
    milestone_day: String,
    milestone_hour: String,
    milestone: String,
    agent_replied: String,
    open: String,
    settings: String,
    quit: String,
}

fn phrase(text: &str, fallback: &str) -> String {
    if text.is_empty() { fallback.to_string() } else { text.to_string() }
}

#[derive(Default)]
pub struct Watch {
    settings: Mutex<Settings>,
    phrases: Mutex<Phrases>,
    waiting: Mutex<Vec<Waiting>>,
    milestones: Mutex<Vec<Milestone>>,
    /// `key|day` / `key|hour`: reminders already shown in this run.
    reminded: Mutex<HashSet<String>>,
    clock_started: AtomicBool,
    /// Keys already waiting when last read; `None` until the first read, which notifies nothing.
    known: Mutex<Option<HashSet<String>>>,
    refreshing: AtomicBool,
    dirty: AtomicBool,
    tray: Mutex<Option<TrayIcon>>,
    monitor_started: AtomicBool,
    summoned_at: Mutex<Option<Instant>>,
    pub quitting: AtomicBool,
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    data_dir(app).join("settings.json")
}

pub fn load_settings(app: &AppHandle) -> Settings {
    std::fs::read_to_string(settings_file(app)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn settings(app: &AppHandle) -> Settings {
    app.state::<Watch>().settings.lock().unwrap().clone()
}

// ---------------------------------------------------------------------------
// What is waiting
// ---------------------------------------------------------------------------

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

fn parse_milestones(json: &str) -> Vec<Milestone> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else { return vec![] };
    items
        .iter()
        .filter(|d| d["milestone"] == true)
        .filter_map(|d| {
            let due = chrono_ms(d["due"].as_str()?)?;
            Some(Milestone {
                key: format!("{}#{}", d["project"].as_str().unwrap_or_default(), d["id"]),
                reference: d["ref"].as_str().unwrap_or_default().to_string(),
                title: d["title"].as_str().unwrap_or_default().to_string(),
                due,
            })
        })
        .collect()
}

/// `2026-11-15T23:59:59+08:00` (what nod writes) as ms since the epoch.
fn chrono_ms(iso: &str) -> Option<i64> {
    let b = iso.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let mut rest = &iso[19..];
    if let Some(r) = rest.strip_prefix('.') {
        rest = r.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset_min = match rest {
        "" | "Z" => 0,
        _ => {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            let hh = rest.get(1..3)?.parse::<i64>().ok()?;
            let mm = rest.get(4..6)?.parse::<i64>().ok()?;
            sign * (hh * 60 + mm)
        }
    };
    // Days from the civil date (Howard Hinnant's algorithm).
    let (y2, m2) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let doy = (153 * m2 + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400 + h * 3600 + mi * 60 + s) - offset_min * 60) * 1000)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

/// Which reminder is due now for a milestone `left` ms away, if any: within a day, then within an hour.
pub fn reminder_for(left: i64) -> Option<&'static str> {
    if left <= 0 {
        None
    } else if left <= HOUR_MS {
        Some("hour")
    } else if left <= DAY_MS {
        Some("day")
    } else {
        None
    }
}

/// Milestones about to come up: one reminder within a day, one within an hour.
fn remind(app: &AppHandle, milestones: &[Milestone]) {
    let now = now_ms();
    let due: Vec<(Milestone, &'static str)> = {
        let watch = app.state::<Watch>();
        let mut reminded = watch.reminded.lock().unwrap();
        milestones
            .iter()
            .filter_map(|m| {
                let which = reminder_for(m.due - now)?;
                reminded.insert(format!("{}|{which}", m.key)).then(|| (m.clone(), which))
            })
            .collect()
    };
    if due.is_empty() || settings(app).notify == "off" || background() {
        return;
    }
    let phrases = app.state::<Watch>().phrases.lock().unwrap().clone();
    for (m, which) in due {
        let head = if which == "hour" { phrase(&phrases.milestone_hour, "Milestone in an hour") } else { phrase(&phrases.milestone_day, "Milestone in a day") };
        let _ = app.notification().builder().title(format!("⚑ {} · {head}", m.reference)).body(&m.title).show();
    }
}

/// A refresh every minute, so a milestone's reminder comes on time even when nothing changes.
fn start_clock(app: &AppHandle) {
    if app.state::<Watch>().clock_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            refresh(&app);
        }
    });
}

fn parse_waiting(json: &str) -> Vec<Waiting> {
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(json) else { return vec![] };
    items
        .iter()
        .filter(|d| d["status"] == "needs_decision" && d["deferred_at"].is_null())
        .map(|d| {
            let s = |k: &str| d[k].as_str().unwrap_or_default().to_string();
            let file = s("file");
            let root = file.split("/decisions/").next().unwrap_or_default().to_string();
            Waiting {
                key: format!("{}#{}", s("project"), d["id"]),
                id: d["id"].as_u64().unwrap_or_default(),
                reference: s("ref"),
                project: s("project"),
                title: s("title"),
                root,
                options: d["options"]
                    .as_array()
                    .map(|o| o.iter().map(|o| Opt { key: o["key"].as_str().unwrap_or_default().into(), label: o["label"].as_str().unwrap_or_default().into() }).collect())
                    .unwrap_or_default(),
                default: d["default"].as_str().map(str::to_string),
                urgent: d["urgency"] == "high",
            }
        })
        .collect()
}

/// Re-reads what is waiting; coalesces bursts of monitor events into one read at a time.
pub fn refresh(app: &AppHandle) {
    let watch = app.state::<Watch>();
    watch.dirty.store(true, Ordering::SeqCst);
    if watch.refreshing.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let watch = app.state::<Watch>();
            if !watch.dirty.swap(false, Ordering::SeqCst) {
                watch.refreshing.store(false, Ordering::SeqCst);
                if watch.dirty.load(Ordering::SeqCst) && !watch.refreshing.swap(true, Ordering::SeqCst) {
                    continue;
                }
                break;
            }
            let Some(env) = env_now(&app) else { continue };
            let Ok(mut cmd) = decs_command(&env, &["show".into(), "--json".into()], None) else { continue };
            let Ok(out) = cmd.output().await else { continue };
            if !out.status.success() {
                continue;
            }
            let flagged = match decs_command(&env, &["show".into(), "flagged".into(), "--json".into()], None) {
                Ok(mut cmd) => match cmd.output().await {
                    Ok(o) if o.status.success() => parse_milestones(&String::from_utf8_lossy(&o.stdout)),
                    _ => vec![],
                },
                Err(_) => vec![],
            };
            *app.state::<Watch>().milestones.lock().unwrap() = flagged.clone();
            apply(&app, parse_waiting(&String::from_utf8_lossy(&out.stdout)));
            remind(&app, &flagged);
        }
    });
}

fn apply(app: &AppHandle, now: Vec<Waiting>) {
    let watch = app.state::<Watch>();
    let keys: HashSet<String> = now.iter().map(|w| w.key.clone()).collect();
    let fresh: Vec<Waiting> = {
        let mut known = watch.known.lock().unwrap();
        let fresh = match known.as_ref() {
            Some(before) => now.iter().filter(|w| !before.contains(&w.key)).cloned().collect(),
            None => vec![],
        };
        *known = Some(keys);
        fresh
    };
    *watch.waiting.lock().unwrap() = now.clone();
    update_tray(app, &now);
    let _ = app.emit("waiting", &now);
    if let Some(first) = fresh.first() {
        announce(app, first, fresh.len());
    }
}

fn announce(app: &AppHandle, w: &Waiting, how_many: usize) {
    let style = settings(app).notify;
    if noddit_env::is_set("APP_TIMING") {
        eprintln!("decs-app: announce {} ({how_many} new) as {style}", w.reference);
    }
    match style.as_str() {
        "banner" => show_banner(app, Some(w.clone()), false),
        "system" => {
            let phrases = app.state::<Watch>().phrases.lock().unwrap().clone();
            let more = if how_many > 1 { format!("  +{}", how_many - 1) } else { String::new() };
            let head = if phrases.needs_decision.is_empty() { w.reference.clone() } else { format!("{} · {}", w.reference, phrases.needs_decision) };
            if !background() {
                let _ = app.notification().builder().title(format!("{head}{more}")).body(&w.title).show();
            }
        }
        _ => {}
    }
}

/// An agent's first reply after something the owner wrote (`owner_facing` on an update line).
fn announce_replies(app: &AppHandle, line: &Value) {
    let refs: Vec<&str> = line["owner_facing"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    if refs.is_empty() || settings(app).notify == "off" || background() {
        return;
    }
    let phrases = app.state::<Watch>().phrases.lock().unwrap().clone();
    let _ = app.notification().builder().title(refs.join(" ")).body(phrase(&phrases.agent_replied, "an AI replied")).show();
}

/// `decs monitor` says an answer has sat uncollected: the owner may want to nudge an agent.
fn announce_unclaimed(app: &AppHandle, line: &Value) {
    if settings(app).notify == "off" {
        return;
    }
    let phrases = app.state::<Watch>().phrases.lock().unwrap().clone();
    let reference = line["ref"].as_str().unwrap_or_default();
    let title = line["title"].as_str().unwrap_or_default();
    let head = if phrases.not_collected.is_empty() { reference.to_string() } else { format!("{reference} · {}", phrases.not_collected) };
    if !background() {
        let _ = app.notification().builder().title(head).body(title).show();
    }
}

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

/// `decs monitor --updates --json`, restarted whenever it exits; every line re-reads what waits.
pub fn start_monitor(app: &AppHandle) {
    if app.state::<Watch>().monitor_started.swap(true, Ordering::SeqCst) {
        return;
    }
    start_clock(app);
    let app = app.clone();
    let mut args: Vec<String> = ["monitor", "--updates", "--json", "--idle-exit", "0", "--interval", "800", "--all", "--unclaimed-after", "10m", "--with-parent"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push(std::process::id().to_string());
    tauri::async_runtime::spawn(async move {
        // Finding decs may run a login shell: never on the main thread, nor blocking a worker.
        let found = {
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || env_now(&app).and_then(|e| e.decs)).await.ok().flatten()
        };
        if found.is_none() {
            app.state::<Watch>().monitor_started.store(false, Ordering::SeqCst);
            return;
        }
        refresh(&app);
        loop {
            let Some(env) = env_now(&app) else { break };
            let Ok(mut cmd) = decs_command(&env, &args, None) else { break };
            cmd.stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
            if let Ok(mut child) = cmd.spawn() {
                if let Some(pid) = child.id() {
                    *app.state::<AppState>().monitor.lock().unwrap() = Some(pid);
                }
                if let Some(stdout) = child.stdout.take() {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        let parsed: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
                        if parsed["event"] == "unclaimed" {
                            announce_unclaimed(&app, &parsed);
                        }
                        announce_replies(&app, &parsed);
                        refresh(&app);
                        let _ = app.emit("decs-event", line);
                    }
                }
                let _ = child.wait().await;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    let menu = Menu::with_items(app, &[&MenuItem::with_id(app, "open", "Open Noddit", true, None::<&str>)?, &PredefinedMenuItem::separator(app)?, &MenuItem::with_id(app, "quit", "Quit Noddit", true, None::<&str>)?])?;
    let tray = TrayIconBuilder::with_id("decs")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Noddit")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| on_menu(app, event.id.as_ref()))
        .build(app)?;
    *app.state::<Watch>().tray.lock().unwrap() = Some(tray);
    Ok(())
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "quit" => {
            app.state::<Watch>().quitting.store(true, Ordering::SeqCst);
            app.exit(0);
        }
        "open" => show_main(app, None),
        "settings" => {
            show_main(app, None);
            let _ = app.emit_to("main", "open-settings", ());
        }
        other => {
            if let Some(key) = other.strip_prefix("node:") {
                show_main(app, Some(key.to_string()));
            }
        }
    }
}

/// Tray calls hop to the main thread and wait for it. So the state is copied out first
/// and no lock is held, and the work itself is posted to the main thread rather than
/// waited on: a command running there that wants one of these locks can never deadlock
/// against a worker that holds it.
fn update_tray(app: &AppHandle, waiting: &[Waiting]) {
    let watch = app.state::<Watch>();
    let count = waiting.len();
    if noddit_env::is_set("APP_TIMING") {
        eprintln!("decs-app: tray {count} waiting");
    }
    let Some(tray) = watch.tray.lock().unwrap().clone() else { return };
    let words = watch.phrases.lock().unwrap().clone();
    let now = now_ms();
    // Milestones within a day (or past) count as much as a decision waiting.
    let soon: Vec<Milestone> = watch.milestones.lock().unwrap().iter().filter(|m| m.due - now <= DAY_MS).cloned().collect();
    let waiting = waiting.to_vec();
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || draw_tray(&handle, &tray, &waiting, &soon, &words));
}

fn draw_tray(app: &AppHandle, tray: &TrayIcon, waiting: &[Waiting], soon: &[Milestone], words: &Phrases) {
    let count = waiting.len() + soon.len();
    #[cfg(target_os = "macos")]
    let _ = tray.set_title(if count > 0 { Some(count.to_string()) } else { None });
    let _ = tray.set_tooltip(Some(if count > 0 { format!("Noddit · {count}") } else { "Noddit".into() }));
    let build = || -> tauri::Result<Menu<tauri::Wry>> {
        let menu = Menu::new(app)?;
        for m in soon.iter().take(TRAY_ITEMS) {
            menu.append(&MenuItem::with_id(app, format!("node:{}", m.key), format!("⚑ {}  {}", m.reference, m.title), true, None::<&str>)?)?;
        }
        for w in waiting.iter().take(TRAY_ITEMS) {
            let label = format!("{}{}  {}", if w.urgent { "! " } else { "" }, w.reference, w.title);
            menu.append(&MenuItem::with_id(app, format!("node:{}", w.key), label, true, None::<&str>)?)?;
        }
        if waiting.len() > TRAY_ITEMS {
            menu.append(&MenuItem::with_id(app, "open", format!("+{}", waiting.len() - TRAY_ITEMS), true, None::<&str>)?)?;
        }
        if count > 0 {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        menu.append(&MenuItem::with_id(app, "open", phrase(&words.open, "Open Noddit"), true, None::<&str>)?)?;
        menu.append(&MenuItem::with_id(app, "settings", phrase(&words.settings, "Settings…"), true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "quit", phrase(&words.quit, "Quit Noddit"), true, None::<&str>)?)?;
        Ok(menu)
    };
    if let Ok(menu) = build() {
        let _ = tray.set_menu(Some(menu));
    }
}

// ---------------------------------------------------------------------------
// Windows: main, banner
// ---------------------------------------------------------------------------

pub fn show_main(app: &AppHandle, focus_key: Option<String>) {
    if let Some(w) = app.get_webview_window("main") {
        if !background() {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
        if let Some(key) = focus_key {
            let _ = app.emit_to("main", "summon", key);
        }
    }
}

/// Built hidden at startup, so the hotkey only has to show it.
pub fn create_banner(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "banner", WebviewUrl::App("index.html?banner=1".into()))
        .title("Noddit")
        .inner_size(BANNER_WIDTH, BANNER_HEIGHT)
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .focused(false)
        .shadow(true)
        .visible_on_all_workspaces(true)
        .build()?;
    Ok(())
}

fn place_banner(app: &AppHandle, w: &tauri::WebviewWindow) {
    if let Ok(Some(m)) = w.primary_monitor().or_else(|_| app.primary_monitor()) {
        let scale = m.scale_factor();
        let size = m.size().to_logical::<f64>(scale);
        let origin = m.position().to_logical::<f64>(scale);
        #[cfg(target_os = "macos")]
        let y = origin.y + 36.0;
        #[cfg(not(target_os = "macos"))]
        let y = origin.y + size.height - BANNER_HEIGHT - 56.0;
        let _ = w.set_position(LogicalPosition::new(origin.x + size.width - BANNER_WIDTH - 14.0, y));
    }
}

/// `focus`: summoned by the hotkey, so keys answer at once; otherwise it is a notification and does not steal focus.
pub fn show_banner(app: &AppHandle, node: Option<Waiting>, focus: bool) {
    let Some(w) = app.get_webview_window("banner") else { return };
    let waiting = app.state::<Watch>().waiting.lock().unwrap().clone();
    let node = node.or_else(|| waiting.first().cloned());
    let Some(node) = node else {
        show_main(app, None);
        return;
    };
    place_banner(app, &w);
    let _ = app.emit_to("banner", "banner-show", serde_json::json!({ "node": node, "count": waiting.len(), "focus": focus }));
    if !background() {
        let _ = w.show();
        if focus {
            let _ = w.set_focus();
        }
    }
}

// ---------------------------------------------------------------------------
// Hotkey
// ---------------------------------------------------------------------------

pub fn on_hotkey(app: &AppHandle, state: ShortcutState) {
    if state != ShortcutState::Pressed {
        return;
    }
    let watch = app.state::<Watch>();
    *watch.summoned_at.lock().unwrap() = Some(Instant::now());
    let first = watch.waiting.lock().unwrap().first().cloned();
    if settings(app).notify == "banner" && first.is_some() {
        show_banner(app, first, true);
    } else {
        show_main(app, Some(first.map(|w| w.key).unwrap_or_default()));
    }
}

pub fn register_hotkey(app: &AppHandle, hotkey: &str) -> Result<(), String> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if hotkey.trim().is_empty() {
        return Ok(());
    }
    gs.register(hotkey).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    settings: Settings,
    default_hotkey: String,
    ctrl_space_taken: bool,
    hotkey_error: Option<String>,
}

#[tauri::command]
pub fn settings_get(app: AppHandle) -> SettingsView {
    let s = settings(&app);
    let registered = s.hotkey.is_empty() || app.global_shortcut().is_registered(s.hotkey.as_str());
    SettingsView {
        hotkey_error: if registered { None } else { Some("not registered".into()) },
        settings: s,
        default_hotkey: default_hotkey(),
        ctrl_space_taken: ctrl_space_switches_input(),
    }
}

#[tauri::command]
pub fn settings_set(app: AppHandle, settings: Settings) -> Result<(), String> {
    let previous = self::settings(&app);
    if settings.hotkey != previous.hotkey && !background() {
        if let Err(e) = register_hotkey(&app, &settings.hotkey) {
            let _ = register_hotkey(&app, &previous.hotkey);
            return Err(e);
        }
    }
    std::fs::write(settings_file(&app), serde_json::to_string_pretty(&settings).unwrap_or_default()).map_err(|e| e.to_string())?;
    *app.state::<Watch>().settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub async fn set_phrases(app: AppHandle, phrases: Phrases) {
    *app.state::<Watch>().phrases.lock().unwrap() = phrases;
    let waiting = app.state::<Watch>().waiting.lock().unwrap().clone();
    update_tray(&app, &waiting);
}

#[tauri::command]
pub fn waiting_get(app: AppHandle) -> Vec<Waiting> {
    app.state::<Watch>().waiting.lock().unwrap().clone()
}

#[tauri::command]
pub fn banner_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window("banner") {
        let _ = w.hide();
    }
}

#[tauri::command]
pub fn banner_open_main(app: AppHandle, key: String) {
    banner_hide(app.clone());
    show_main(&app, Some(key));
}

/// The window or banner drew the summoned decision: how long since the hotkey was pressed.
#[tauri::command]
pub fn summoned(app: AppHandle, what: String) -> Option<u128> {
    let ms = app.state::<Watch>().summoned_at.lock().unwrap().take()?.elapsed().as_millis();
    if noddit_env::is_set("APP_TIMING") {
        eprintln!("decs-app: hotkey → {what} visible in {ms} ms");
    }
    Some(ms)
}

/// For scripted runs: press the hotkey without a keyboard, optionally from a hidden window as a user would.
#[tauri::command]
pub async fn press_hotkey(app: AppHandle, hide_first: bool) {
    if hide_first {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.hide();
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    on_hotkey(&app, ShortcutState::Pressed);
}

pub fn init(app: &AppHandle) {
    *app.state::<Watch>().settings.lock().unwrap() = load_settings(app);
    if !background() {
        if let Err(e) = create_tray(app) {
            eprintln!("decs-app: tray: {e}");
        }
    }
    if let Err(e) = create_banner(app) {
        eprintln!("decs-app: banner: {e}");
    }
    let hotkey = if background() { String::new() } else { settings(app).hotkey };
    if let Err(e) = register_hotkey(app, &hotkey) {
        eprintln!("decs-app: hotkey {hotkey}: {e}");
    }
    start_monitor(app);
}

/// On a normal quit; `--with-parent` covers a crash or a kill.
pub fn stop_monitor(app: &AppHandle) {
    if let Some(pid) = app.state::<AppState>().monitor.lock().unwrap().take() {
        let _ = std::process::Command::new("kill").arg(pid.to_string()).status();
    }
}

#[cfg(test)]
mod tests {
    use super::{chrono_ms, reminder_for, DAY_MS, HOUR_MS};

    #[test]
    fn reads_the_times_nod_writes() {
        assert_eq!(chrono_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(chrono_ms("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(chrono_ms("2026-11-15T23:59:59.250+08:00"), chrono_ms("2026-11-15T15:59:59Z"));
        assert_eq!(chrono_ms("2026-11-15T15:59:59Z"), Some(1_794_758_399_000));
    }

    #[test]
    fn a_day_before_then_an_hour_before_nothing_after() {
        assert_eq!(reminder_for(2 * DAY_MS), None);
        assert_eq!(reminder_for(DAY_MS), Some("day"));
        assert_eq!(reminder_for(2 * HOUR_MS), Some("day"));
        assert_eq!(reminder_for(HOUR_MS), Some("hour"));
        assert_eq!(reminder_for(-1), None);
    }
}
