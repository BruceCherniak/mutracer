fn main() {
    println!("cargo:rerun-if-env-changed=MUTRACER_AOT_ARCHIVE");
    let archive = std::env::var("MUTRACER_AOT_ARCHIVE")
        .expect("Set MUTRACER_AOT_ARCHIVE to the scriptc render-core.lib.a");
    println!("cargo:rerun-if-changed={archive}");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::copy(archive, output.join("libmutracer_aot.a")).unwrap();
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=mutracer_aot");
}
