fn main() {
    // The app's own commands, so a capability can allow them one by one.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["update_status", "install_update", "restart_server", "take_links"]),
    ))
    .expect("failed to run the Tauri build script");
}
