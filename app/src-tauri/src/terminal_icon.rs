//! The target terminal's own icon for the project context menu's "go to session" item.
//! Never bundled — it is someone else's trademark — so it is fetched from whatever copy
//! is installed, through macOS's own NSWorkspace, and cached once per process: the owner
//! can right-click the same project many times in one run.

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// 16pt at 2x, the size a native menu item's icon is drawn at.
#[cfg(target_os = "macos")]
const ICON_PX: f64 = 32.0;

#[derive(Default)]
pub struct IconCache(Mutex<HashMap<String, Option<Vec<u8>>>>);

impl IconCache {
    fn cached(&self, bundle_id: &str) -> Option<Option<Vec<u8>>> {
        self.0.lock().unwrap().get(bundle_id).cloned()
    }

    fn store(&self, bundle_id: String, icon: Option<Vec<u8>>) {
        self.0.lock().unwrap().insert(bundle_id, icon);
    }
}

/// PNG bytes of the app's own icon (by bundle id), or `None` when it can't be found — the
/// app isn't installed, or the icon couldn't be rendered. Never an error: a menu item with
/// no icon just shows its text.
#[tauri::command]
pub async fn terminal_icon(app: AppHandle, state: State<'_, IconCache>, bundle_id: String) -> Result<Option<Vec<u8>>, String> {
    if let Some(hit) = state.cached(&bundle_id) {
        return Ok(hit);
    }
    let Some(window) = app.get_webview_window("main") else { return Ok(None) };
    let (tx, rx) = std::sync::mpsc::channel();
    let id = bundle_id.clone();
    // AppKit: fetched and rendered on the main thread, same as resize.rs's NSWindow access.
    if window.run_on_main_thread(move || { let _ = tx.send(fetch(&id)); }).is_err() {
        return Ok(None);
    }
    let icon = rx.recv().unwrap_or(None);
    state.store(bundle_id, icon.clone());
    Ok(icon)
}

#[cfg(target_os = "macos")]
fn fetch(bundle_id: &str) -> Option<Vec<u8>> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSWorkspace};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    let workspace = NSWorkspace::sharedWorkspace();
    let id = NSString::from_str(bundle_id);
    let app_url = workspace.URLForApplicationWithBundleIdentifier(&id)?;
    let path = app_url.path()?;
    let icon = workspace.iconForFile(&path);

    // Redrawn into a fixed-size canvas so the result is exactly ICON_PX square, whatever
    // resolutions the app's own .icns happens to carry.
    let size = NSSize::new(ICON_PX, ICON_PX);
    let canvas = NSImage::initWithSize(NSImage::alloc(), size);
    #[allow(deprecated)]
    {
        canvas.lockFocus();
        icon.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
        canvas.unlockFocus();
    }

    let tiff = canvas.TIFFRepresentation()?;
    let rep = NSBitmapImageRep::imageRepWithData(&tiff)?;
    let props = NSDictionary::new();
    // SAFETY: `properties` is an empty dictionary, the type `representationUsingType_properties`
    // itself expects.
    let png = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &props) }?;
    Some(png.to_vec())
}

#[cfg(not(target_os = "macos"))]
fn fetch(_bundle_id: &str) -> Option<Vec<u8>> {
    None
}
