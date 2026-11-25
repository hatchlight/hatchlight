//! Links that open the app, such as `hatchlight://hf/<owner>/<repo>` from
//! Hugging Face's "Use this model" menu. The system hands them to the app,
//! or to the copy already running; they wait here until the app's page takes
//! them. The page reads them strictly: here they are only kept short and few.

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State, Url};

/// Only links of the app's own scheme are taken.
const SCHEME: &str = "hatchlight";
/// Longer links are not ones the app makes or reads.
const MAX_LINK: usize = 2048;
/// Links that wait for the page beyond these are dropped, oldest first.
const MAX_WAITING: usize = 8;

/// Links the page has not taken yet.
#[derive(Default)]
pub struct Links(Mutex<Vec<String>>);

/// Keeps the app's own links for the page, brings the window forward and
/// tells the page there are links to take.
pub fn receive(app: &AppHandle, urls: Vec<Url>) {
    let links: Vec<String> = urls
        .into_iter()
        .filter(|url| url.scheme() == SCHEME && url.as_str().len() <= MAX_LINK)
        .map(String::from)
        .collect();
    if links.is_empty() {
        return;
    }
    let state = app.state::<Links>();
    {
        let mut waiting = state.0.lock().unwrap();
        waiting.extend(links);
        let extra = waiting.len().saturating_sub(MAX_WAITING);
        waiting.drain(..extra);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit_to("main", "links-waiting", ());
}

/// The links waiting for the page, which are then no longer kept.
#[tauri::command]
pub fn take_links(links: State<Links>) -> Vec<String> {
    std::mem::take(&mut *links.0.lock().unwrap())
}
