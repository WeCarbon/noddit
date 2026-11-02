//! Resizing the main window from inside it: thin handles along the page's edges call
//! these while the mouse drags them. The system's own edge resizing stays as it is;
//! these make sure the edges always respond, whatever the WebView does with the mouse.

use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// The window's frame when the drag started, in points, origin bottom-left (macOS) or top-left.
#[derive(Default)]
pub struct ResizeStart(Mutex<Option<(f64, f64, f64, f64)>>);

const MIN_WIDTH: f64 = 760.0;
const MIN_HEIGHT: f64 = 480.0;

/// Which edges the handle moves: `n`, `s`, `e`, `w` or a corner like `ne`.
fn edges(edge: &str) -> (bool, bool, bool, bool) {
    (edge.contains('n'), edge.contains('s'), edge.contains('e'), edge.contains('w'))
}

/// The frame after dragging `edge` by `dx`, `dy` (points, y growing downwards), never
/// below the minimum size and never moving the opposite edge. `y_up`: origin at the bottom.
pub fn resized(start: (f64, f64, f64, f64), edge: &str, dx: f64, dy: f64, y_up: bool) -> (f64, f64, f64, f64) {
    let (x, y, w, h) = start;
    let (n, s, e, west) = edges(edge);
    let mut nw = w;
    let mut nh = h;
    if e {
        nw = (w + dx).max(MIN_WIDTH);
    }
    if west {
        nw = (w - dx).max(MIN_WIDTH);
    }
    if s {
        nh = (h + dy).max(MIN_HEIGHT);
    }
    if n {
        nh = (h - dy).max(MIN_HEIGHT);
    }
    let nx = if west { x + (w - nw) } else { x };
    // Bottom-left origin: the bottom edge moving down lowers the origin; the top edge leaves it.
    let ny = if y_up {
        if s { y - (nh - h) } else { y }
    } else if n {
        y + (h - nh)
    } else {
        y
    };
    (nx, ny, nw, nh)
}

#[tauri::command]
pub async fn resize_begin(app: AppHandle, state: State<'_, ResizeStart>) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    // Off the main thread (async): frame_of waits for the main thread to read the frame.
    let frame = frame_of(&window)?;
    *state.0.lock().unwrap() = Some(frame);
    Ok(())
}

#[tauri::command]
pub async fn resize_to(app: AppHandle, state: State<'_, ResizeStart>, edge: String, dx: f64, dy: f64) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let start = *state.0.lock().unwrap();
    let Some(start) = start else { return Ok(()) };
    let next = resized(start, &edge, dx, dy, cfg!(target_os = "macos"));
    set_frame(&window, next)
}

#[cfg(target_os = "macos")]
fn frame_of(window: &tauri::WebviewWindow) -> Result<(f64, f64, f64, f64), String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())?;
    let (tx, rx) = std::sync::mpsc::channel();
    let addr = ptr as usize;
    window
        .run_on_main_thread(move || {
            // SAFETY: tao's NSWindow, only touched on the main thread.
            let ns: &objc2_app_kit::NSWindow = unsafe { &*(addr as *const objc2_app_kit::NSWindow) };
            let f = ns.frame();
            let _ = tx.send((f.origin.x, f.origin.y, f.size.width, f.size.height));
        })
        .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn set_frame(window: &tauri::WebviewWindow, (x, y, w, h): (f64, f64, f64, f64)) -> Result<(), String> {
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    let addr = window.ns_window().map_err(|e| e.to_string())? as usize;
    window
        .run_on_main_thread(move || {
            // SAFETY: as in frame_of.
            let ns: &objc2_app_kit::NSWindow = unsafe { &*(addr as *const objc2_app_kit::NSWindow) };
            ns.setFrame_display(NSRect::new(NSPoint::new(x, y), NSSize::new(w, h)), true);
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
fn frame_of(window: &tauri::WebviewWindow) -> Result<(f64, f64, f64, f64), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let p = window.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let s = window.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    Ok((p.x, p.y, s.width, s.height))
}

#[cfg(not(target_os = "macos"))]
fn set_frame(window: &tauri::WebviewWindow, (x, y, w, h): (f64, f64, f64, f64)) -> Result<(), String> {
    window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    window.set_size(tauri::LogicalSize::new(w, h)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::resized;

    #[test]
    fn east_and_south_grow_without_moving_the_origin() {
        assert_eq!(resized((100.0, 50.0, 1000.0, 700.0), "se", 40.0, 30.0, false), (100.0, 50.0, 1040.0, 730.0));
    }

    #[test]
    fn west_and_north_move_the_origin_so_the_other_edges_stay() {
        assert_eq!(resized((100.0, 50.0, 1000.0, 700.0), "nw", -40.0, -30.0, false), (60.0, 20.0, 1040.0, 730.0));
    }

    #[test]
    fn bottom_left_origin_moves_down_with_the_bottom_edge() {
        assert_eq!(resized((100.0, 300.0, 1000.0, 700.0), "s", 0.0, 30.0, true), (100.0, 270.0, 1000.0, 730.0));
        assert_eq!(resized((100.0, 300.0, 1000.0, 700.0), "n", 0.0, -30.0, true), (100.0, 300.0, 1000.0, 730.0));
    }

    #[test]
    fn never_smaller_than_the_minimum_and_the_far_edge_holds() {
        assert_eq!(resized((100.0, 50.0, 800.0, 500.0), "w", 200.0, 0.0, false), (140.0, 50.0, 760.0, 500.0));
    }
}
