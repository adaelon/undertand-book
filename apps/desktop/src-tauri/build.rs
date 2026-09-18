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
        .expect("failed to build Understand Book desktop application");
    // The host probe includes the actual desktop entry and needs the same Windows
    // common-controls manifest. tauri-build links this resource only to bin targets.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        println!("cargo:rustc-link-arg-examples={}", resource.display());
    }
}
