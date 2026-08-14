fn main() {
    // Rebuild when brand icons change so Windows embeds the latest .ico into the exe.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=icons/32x32.png");
    println!("cargo:rerun-if-changed=icons/128x128.png");
    println!("cargo:rerun-if-changed=icons/henry.w@example.net");
    tauri_build::build()
}
