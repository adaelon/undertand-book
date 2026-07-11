fn main() {
    println!("cargo:rerun-if-env-changed=UNDERSTAND_BOOK_MARKETPLACE_SOURCE");
    println!("cargo:rerun-if-env-changed=UNDERSTAND_BOOK_MARKETPLACE_NAME");
    let app_manifest = tauri_build::AppManifest::new().commands(&[
        "codex_plugin_status",
        "install_codex_plugin",
        "set_desktop_library_directory",
        "desktop_provider_status",
        "save_desktop_provider_settings",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(app_manifest))
        .expect("failed to build Understand Book desktop application")
}
