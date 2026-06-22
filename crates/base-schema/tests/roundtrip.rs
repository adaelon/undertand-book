use base_schema::{sample_base, ReadOnlyBase};
use std::path::Path;

/// Rust 侧自洽:serialize → deserialize 零失配。
#[test]
fn rust_sample_roundtrips() {
    let base = sample_base();
    let json = serde_json::to_string_pretty(&base).expect("serialize");
    let back: ReadOnlyBase = serde_json::from_str(&json).expect("deserialize");
    assert_eq!(base, back, "Rust serialize→deserialize 必须无损");
}

/// 跨语言闸:读 TS(vitest)产出的 fixture,serde 读入零失配。
/// fixture 未产出时跳过(passes)——它由 packages/core 的 vitest 步骤生成;
/// 一旦存在,字段失配在此 fail(非静默),兑现 S0 判据①。
#[test]
fn ts_fixture_deserializes_zero_mismatch() {
    let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/sample-base.json");
    if !p.exists() {
        eprintln!("[skip] TS fixture 尚未产出: {}", p.display());
        return;
    }
    let json = std::fs::read_to_string(&p).expect("read fixture");
    let base: ReadOnlyBase = serde_json::from_str(&json)
        .expect("TS 产出的基座必须能被 Rust schema 零失配反序列化");
    assert_eq!(base.book_id, "sample-book");
    assert_eq!(base, sample_base(), "TS fixture 必须与 Rust sample_base 逐字段一致");
}
