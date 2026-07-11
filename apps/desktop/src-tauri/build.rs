fn main() {
    println!("cargo:rerun-if-env-changed=UNDERSTAND_BOOK_MARKETPLACE_SOURCE");
    println!("cargo:rerun-if-env-changed=UNDERSTAND_BOOK_MARKETPLACE_NAME");
    tauri_build::build()
}
