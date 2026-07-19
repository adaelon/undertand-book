use base_schema::{
    sample_base, BuildTargetRefV2, ExtractionPolicyFingerprintV1, ExtractionQualityProfile,
    ReadOnlyBase, SemanticArtifactEnvelopeV2, SemanticArtifactProvenanceV2,
};
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

#[test]
fn semantic_artifact_v2_roundtrips_without_flattening_payload() {
    let envelope = SemanticArtifactEnvelopeV2 {
        version: "semantic_task_artifact.v2".into(),
        target: BuildTargetRefV2 {
            version: "build_target_ref.v2".into(),
            workspace_dir: "C:/repo/.understand-book/guide".into(),
            book_id: "guide".into(),
            profile_id: "technical_learning".into(),
            input_fingerprint: "input-fingerprint".into(),
        },
        stage: "pass1".into(),
        work_unit_id: "0".into(),
        input_hash: "input-hash".into(),
        policy_fingerprint: ExtractionPolicyFingerprintV1 {
            profile_id: "technical_learning".into(),
            profile_version: "technical_learning_v0".into(),
            stage_policy_version: "pass1_policy.v1".into(),
            router_version: "pass1_window.v1".into(),
            prompt_sha256: "a".repeat(64),
            schema_version: "pass1_output.v1".into(),
            quality_profile: ExtractionQualityProfile::Full,
        },
        artifact_hash: "b".repeat(64),
        provenance: SemanticArtifactProvenanceV2 {
            executor: "codex-harness".into(),
            model: Some("gpt-5.4-codex".into()),
            attempt: 1,
            generated_at: "2026-07-19T00:00:00.000Z".into(),
        },
        payload: serde_json::json!({ "content_hash": "input-hash", "nodes": [], "edges": [] }),
    };
    let json = serde_json::to_string(&envelope).expect("serialize semantic artifact");
    let back: SemanticArtifactEnvelopeV2 =
        serde_json::from_str(&json).expect("deserialize semantic artifact");
    assert_eq!(back, envelope);
    assert_eq!(back.version, "semantic_task_artifact.v2");
    assert_eq!(back.payload["content_hash"], "input-hash");
}
