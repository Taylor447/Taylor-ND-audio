use std::{env, path::PathBuf};

fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let header = root.join("include").join("tnd_dsp.h");
    let config = cbindgen::Config::from_file(root.join("cbindgen.toml")).expect("cbindgen.toml");
    std::fs::create_dir_all(header.parent().expect("thư mục include")).expect("tạo include");
    cbindgen::Builder::new()
        .with_crate(&root)
        .with_config(config)
        .generate()
        .expect("cbindgen tạo header C")
        .write_to_file(header);
}
