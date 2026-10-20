fn main() {
    println!("cargo:rerun-if-changed=../include/mutracer-layout.h");
    // This is the same wrapper used by the WebAssembly build, linked natively.
    println!("cargo:rerun-if-changed=tinybvh.cpp");
    println!("cargo:rerun-if-changed=../../src/tinybvh/tinybvh_wrapper.cpp");
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let manifest_path = root.join("src/tinybvh/upstream.json");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    let include = root
        .join(".cache/tinybvh")
        .join(manifest["revision"].as_str().unwrap());
    for file in manifest["files"].as_array().unwrap() {
        let header = include.join(file["file"].as_str().unwrap());
        assert!(
            header.is_file(),
            "TinyBVH header missing: {}. Run npm run fetch:tinybvh from the repository root before Cargo.",
            header.display()
        );
        println!("cargo:rerun-if-changed={}", header.display());
    }
    cc::Build::new()
        .cpp(true)
        .std("c++20")
        .opt_level(3)
        // Preserve conservative bounds across native SIMD and scalar Wasm.
        .flag_if_supported("-ffp-contract=off")
        .file("tinybvh.cpp")
        .include(include)
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
