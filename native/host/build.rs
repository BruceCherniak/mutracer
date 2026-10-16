fn main() {
    // This is the same wrapper used by the WebAssembly build, linked natively.
    // Upstream:tinybvh@0e4584287823252cf83f0e9cd072848bec5f79c5.
    println!("cargo:rerun-if-changed=tinybvh.cpp");
    println!("cargo:rerun-if-changed=../../src/tinybvh/tinybvh_wrapper.cpp");
    println!("cargo:rerun-if-changed=../vendor/tinybvh/tiny_bvh.h");
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .opt_level(3)
        // Preserve conservative bounds across native SIMD and scalar Wasm.
        .flag_if_supported("-ffp-contract=off")
        .file("tinybvh.cpp")
        .include("../vendor/tinybvh")
        .warnings(false)
        .compile("mutracer_tinybvh");
    println!("cargo:rerun-if-env-changed=MUTRACER_AOT_ARCHIVE");
    let archive = std::env::var("MUTRACER_AOT_ARCHIVE")
        .expect("Set MUTRACER_AOT_ARCHIVE to the scriptc render-core.lib.a");
    println!("cargo:rerun-if-changed={archive}");
    let output = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap());
    std::fs::copy(archive, output.join("libmutracer_aot.a")).unwrap();
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=mutracer_aot");
}
