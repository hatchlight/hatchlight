// No console window next to the app on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop app: a window around the same server `bun run start` runs.
//! The server is a compiled sidecar on a free loopback port; the window shows
//! a splash until the server says where it listens, then opens the app there.

mod links;
mod update;

use std::fs::{create_dir_all, File};
use std::io::Write;
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use tauri::webview::NewWindowResponse;
use tauri::window::Color;
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// The line the server prints once it listens, followed by its address.
const READY: &str = "Hatchlight is running at ";
/// The app's background, so the window never flashes white.
const BACKGROUND: Color = Color(9, 9, 11, 255);

/// The running server. Dropping it closes the server's input, which tells it
/// to shut down cleanly; a kill would leave its lock and database unflushed.
pub struct Server(pub Mutex<Option<CommandChild>>);

/// Pages that belong to the app: its splash, the local server, and what the
/// webview loads on its own (WebView2 starts at `about:blank`).
fn is_internal(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "about" | "data" | "blob" => true,
        "http" | "https" => matches!(
            url.host_str(),
            Some("localhost" | "127.0.0.1" | "tauri.localhost")
        ),
        _ => false,
    }
}

/// Opens web and mail links, such as a provider's key page, in the system
/// browser. Anything else is just refused: handing an unknown scheme to the
/// system would ask the person which app should open it.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}

/// The splash's address. Asked of the window instead, it can still be
/// `about:blank` while the webview starts (WebView2 does that).
fn splash_url() -> Url {
    let origin = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    Url::parse(&format!("{origin}/splash.html")).expect("a valid address")
}

/// Shows the splash again, saying why the server stopped.
fn show_failure(window: &WebviewWindow, detail: &str) {
    let mut url = splash_url();
    url.query_pairs_mut().append_pair("failed", detail.trim());
    let _ = window.navigate(url);
}

/// Keeps what the server says in `server.log`, next to the app's other logs,
/// so a failure can be looked into after the window is gone.
fn open_log(app: &AppHandle) -> Option<File> {
    let dir = app.path().app_log_dir().ok()?;
    create_dir_all(&dir).ok()?;
    let mut file = File::create(dir.join("server.log")).ok()?;
    let _ = writeln!(file, "Hatchlight {}", app.package_info().version);
    Some(file)
}

fn start_server(app: &AppHandle, window: WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    // Windows paths come as `\\?\C:\...`, where forward slashes are not
    // separators; the server's libraries join paths with them.
    let resources = dunce::simplified(&app.path().resource_dir()?).join("resources");
    let mut log = open_log(app);
    let (mut events, child) = app
        .shell()
        .sidecar("hatchlight-server")?
        .args([
            "--port",
            "0",
            "--no-open",
            "--parent-pid",
            &std::process::id().to_string(),
        ])
        .arg("--resources")
        .arg(resources)
        .spawn()?;
    *app.state::<Server>().0.lock().unwrap() = Some(child);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut ready = false;
        // What the server said on stderr, to show if it stops.
        let mut errors = String::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "{}", line.trim_end());
                    }
                    if let Some(address) = line.trim().strip_prefix(READY) {
                        if let (false, Ok(url)) = (ready, Url::parse(address.trim())) {
                            ready = true;
                            let _ = window.navigate(url);
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    let line = String::from_utf8_lossy(&line);
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "{}", line.trim_end());
                    }
                    errors.push_str(line.trim_end());
                    errors.push('\n');
                }
                CommandEvent::Error(error) => {
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "error: {error}");
                    }
                    errors.push_str(&error);
                    errors.push('\n');
                }
                CommandEvent::Terminated(status) => {
                    app.state::<update::ServerExited>()
                        .0
                        .store(true, Ordering::SeqCst);
                    let stopped = match status.code {
                        Some(code) => format!("The server stopped (code {code})."),
                        None => "The server stopped.".to_string(),
                    };
                    if let Some(file) = log.as_mut() {
                        let _ = writeln!(file, "{stopped}");
                    }
                    // Stopped on purpose to install an update: not a failure.
                    if !app.state::<update::Updating>().0.load(Ordering::SeqCst) {
                        errors.push_str(&stopped);
                        show_failure(&window, &errors);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
    Ok(())
}

/// Starts the server again after it stopped: the splash's "Try again", for
/// when what stopped it is gone, such as another copy of Hatchlight that was
/// using the same data directory. Does nothing while a server is running.
#[tauri::command]
fn restart_server(app: AppHandle) -> Result<(), String> {
    let exited = &app.state::<update::ServerExited>().0;
    if !exited.load(Ordering::SeqCst) || app.state::<update::Updating>().0.load(Ordering::SeqCst) {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("The window is gone.")?;
    drop(app.state::<Server>().0.lock().unwrap().take());
    exited.store(false, Ordering::SeqCst);
    let _ = window.navigate(splash_url());
    start_server(&app, window).map_err(|error| {
        exited.store(true, Ordering::SeqCst);
        format!("Could not start the server: {error}")
    })
}

fn main() {
    let app = tauri::Builder::default()
        // A second launch brings the open window forward instead of starting
        // another server on the same data directory. A link it was started
        // with, such as hatchlight://hf/..., comes to this one (on Windows and
        // Linux the system starts the app again with the link).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Server(Mutex::new(None)))
        .manage(links::Links::default())
        .manage(update::Pending::default())
        .manage(update::Updating::default())
        .manage(update::ServerExited::default())
        .invoke_handler(tauri::generate_handler![
            update::update_status,
            update::install_update,
            restart_server,
            links::take_links
        ])
        .setup(|app| {
            // An AppImage, or a build run from the source, is not installed:
            // the system learns of hatchlight:// links here. Installers set
            // it up themselves, and macOS reads it from the app's bundle.
            #[cfg(target_os = "linux")]
            let unpackaged = cfg!(debug_assertions) || app.env().appimage.is_some();
            #[cfg(windows)]
            let unpackaged = cfg!(debug_assertions);
            #[cfg(any(windows, target_os = "linux"))]
            if unpackaged {
                if let Err(error) = app.deep_link().register_all() {
                    update::log(app.handle(), &format!("Could not register hatchlight:// links: {error}"));
                }
            }
            // The link the app was started with, then those that come later.
            let opened = app.handle().clone();
            app.deep_link().on_open_url(move |event| links::receive(&opened, event.urls()));
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                links::receive(app.handle(), urls);
            }
            let navigation = app.handle().clone();
            let popups = app.handle().clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("splash.html".into()))
                .title("Hatchlight")
                .inner_size(1280.0, 820.0)
                .min_inner_size(720.0, 520.0)
                .background_color(BACKGROUND)
                .on_navigation(move |url| {
                    if is_internal(url) {
                        return true;
                    }
                    open_outside(&navigation, url);
                    false
                })
                // Links that open a new tab go to the system browser.
                .on_new_window(move |url, _features| {
                    open_outside(&popups, &url);
                    NewWindowResponse::Deny
                })
                .build()?;
            if let Err(error) = start_server(app.handle(), window.clone()) {
                // No server to wait for, so "Try again" can start one.
                app.state::<update::ServerExited>().0.store(true, Ordering::SeqCst);
                show_failure(&window, &format!("Could not start the server: {error}"));
            }
            // Independent of the server, so even a version whose server fails
            // to start can still be replaced by the next one.
            tauri::async_runtime::spawn(update::watch(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("could not start Hatchlight");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            drop(app.state::<Server>().0.lock().unwrap().take());
        }
    });
}
