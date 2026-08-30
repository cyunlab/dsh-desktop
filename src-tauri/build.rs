fn main() {
    println!("cargo:rerun-if-env-changed=DSH_UPDATER_ENDPOINT");
    println!("cargo:rerun-if-env-changed=DSH_UPDATER_PUBLIC_KEY");
    tauri_build::build()
}
