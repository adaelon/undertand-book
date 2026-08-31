import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAutomaticBuildSnapshot } from "../src/build-orchestrator";
import {
  automaticBuildGenerationArtifactPath,
} from "../src/semantic-artifact";
import {
  automaticBuildStageCloseResultPath,
  closeAutomaticBuildStage,
  type AutomaticBuildStageCloseResultV2,
} from "../src/automatic-build-close";
import {
  automaticBuildPublicationReceiptPath,
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../src/automatic-build-publication";
import {
  closeSyntheticPass1,
  createSyntheticRoutabilityFixture,
  type SyntheticRoutabilityFixture,
} from "./helpers/model-input-routability-fixture";

function canonical(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function preparedFixture(): SyntheticRoutabilityFixture {
  const fixture = createSyntheticRoutabilityFixture(512);
  closeSyntheticPass1(fixture);
  return fixture;
}

function publishPass1(fixture: SyntheticRoutabilityFixture) {
  const receipt = publishAutomaticBuildArtifactSet({
    workspace_dir: fixture.target.workspace_dir,
    stage: "pass1",
    artifacts: {
      "base.json": readFileSync(path.join(fixture.target.workspace_dir, "base.json")),
      "profile_metadata.json": readFileSync(path.join(fixture.target.workspace_dir, "profile_metadata.json")),
    },
  });
  return buildAutomaticBuildStageBatchResult(receipt);
}

function closePass1(
  fixture: SyntheticRoutabilityFixture,
  runBatch: () => { stdout: string; stderr?: string } = () => ({
    stdout: canonical(publishPass1(fixture)),
  }),
) {
  return closeAutomaticBuildStage({
    target: fixture.target,
    stage: "pass1",
    quality_profile: "full",
    run_batch: runBatch,
  });
}

describe("BR9 publication-aware stage close", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture(): SyntheticRoutabilityFixture {
    const value = preparedFixture();
    roots.push(value.root);
    return value;
  }

  it("closes only from a matching receipt and persists a replan-only result", () => {
    const value = fixture();
    const outcome = closePass1(value);

    expect(outcome).toMatchObject({
      version: "automatic_build_stage_close_result.v2",
      status: "closed",
      stage: "pass1",
      target: {
        book_id: value.target.book_id,
        profile_id: value.target.profile_id,
        input_fingerprint: value.target.target_ref.input_fingerprint,
      },
      quality: { gate_status: "passed" },
      postcondition: { stage_closed: true },
      next: "replan",
    });
    if (outcome.version !== "automatic_build_stage_close_result.v2") {
      throw new Error(`expected close result, received ${outcome.code}`);
    }
    expect(outcome.postcondition.policy_contracts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: expect.any(String),
        policy_generation_id: expect.any(String),
        semantic_contract: expect.any(Object),
      }),
    ]));
    expect(outcome.postcondition.coverage_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.postcondition.freshness_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(outcome.postcondition.public_artifact_set_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(readFileSync(automaticBuildStageCloseResultPath(
      value.target,
      "pass1",
      outcome.publication.transaction_id,
    ), "utf8")).toContain(outcome.publication.receipt_digest);
  });

  it("maps exit-zero human output and mismatched receipt identity to bounded close recovery", () => {
    const noReceipt = fixture();
    expect(closePass1(noReceipt, () => ({ stdout: "[pass1-batch] wrote base.json\n" }))).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "close",
      code: "publication_receipt_invalid",
      stage: "pass1",
      recovery_actions: ["inspect_publication"],
    });

    const stageMismatch = fixture();
    expect(closePass1(stageMismatch, () => {
      const result = publishPass1(stageMismatch);
      const receiptPath = automaticBuildPublicationReceiptPath(
        stageMismatch.target.workspace_dir,
        "pass1",
        result.publication.transaction_id,
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
      writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, stage: "profile_sidecar" }, null, 2)}\n`, "utf8");
      return { stdout: canonical(result) };
    })).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "close",
      code: "publication_receipt_invalid",
      stage: "pass1",
    });

    const transactionMismatch = fixture();
    expect(closePass1(transactionMismatch, () => {
      const result = publishPass1(transactionMismatch);
      const receiptPath = automaticBuildPublicationReceiptPath(
        transactionMismatch.target.workspace_dir,
        "pass1",
        result.publication.transaction_id,
      );
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>;
      writeFileSync(receiptPath, `${JSON.stringify({ ...receipt, transaction_id: "0".repeat(64) }, null, 2)}\n`, "utf8");
      return { stdout: canonical(result) };
    })).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "close",
      code: "publication_receipt_invalid",
      stage: "pass1",
    });
  });

  it("fails the postcondition when a published public file is deleted", () => {
    const value = fixture();
    const outcome = closePass1(value, () => {
      const result = publishPass1(value);
      rmSync(path.join(value.target.workspace_dir, "base.json"));
      return { stdout: canonical(result) };
    });

    expect(outcome).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "pass1",
    });
  });

  it("fails the postcondition when quality drifts after publication", () => {
    const value = fixture();
    const outcome = closePass1(value, () => {
      const result = publishPass1(value);
      const stage = buildAutomaticBuildSnapshot(value.target, { quality_profile: "full" })
        .stages.find((candidate) => candidate.stage === "pass1");
      const generationEntry = Object.entries(stage?.generation_tasks ?? {})[0];
      if (!generationEntry) throw new Error("expected a frozen Pass1 policy generation");
      const [workUnitId, generationTask] = generationEntry;
      const artifactPath = automaticBuildGenerationArtifactPath(
        value.target,
        "pass1",
        generationTask.task.policy_generation_id,
        workUnitId,
      );
      const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as Record<string, unknown>;
      writeFileSync(artifactPath, `${JSON.stringify({ ...artifact, artifact_hash: "0".repeat(64) }, null, 2)}\n`, "utf8");
      return { stdout: canonical(result) };
    });

    expect(outcome).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "pass1",
    });
  });

  it("returns the same create-only result for an identical repeated close", () => {
    const value = fixture();
    const first = closePass1(value);
    const second = closePass1(value);
    expect(first).toEqual(second);
  });

  it("leaves a V1 predecessor read-only and returns bounded recovery", () => {
    const value = fixture();
    const first = closePass1(value);
    if (first.version !== "automatic_build_stage_close_result.v2") {
      throw new Error(`expected close result, received ${first.code}`);
    }
    const resultPath = automaticBuildStageCloseResultPath(
      value.target,
      "pass1",
      first.publication.transaction_id,
    );
    const { policy_contracts: _policyContracts, ...commonPostcondition } = first.postcondition;
    const predecessor = {
      ...first,
      version: "automatic_build_stage_close_result.v1",
      postcondition: {
        ...commonPostcondition,
        policy_set_digest: "a".repeat(64),
      },
    };
    const predecessorBytes = `${JSON.stringify(predecessor, null, 2)}\n`;
    writeFileSync(resultPath, predecessorBytes, "utf8");

    expect(closePass1(value)).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "pass1",
    });
    expect(readFileSync(resultPath, "utf8")).toBe(predecessorBytes);
  });

  it("fails closed without overwriting a conflicting result for the same publication identity", () => {
    const value = fixture();
    const first = closePass1(value);
    if (first.version !== "automatic_build_stage_close_result.v2") {
      throw new Error(`expected close result, received ${first.code}`);
    }
    const resultPath = automaticBuildStageCloseResultPath(
      value.target,
      "pass1",
      first.publication.transaction_id,
    );
    const conflicting: AutomaticBuildStageCloseResultV2 = {
      ...first,
      postcondition: {
        ...first.postcondition,
        freshness_digest: sha256("conflicting close result"),
      },
    };
    writeFileSync(resultPath, `${JSON.stringify(conflicting, null, 2)}\n`, "utf8");

    const outcome = closePass1(value);
    expect(outcome).toMatchObject({
      version: "automatic_build_recovery.v1",
      phase: "post_close",
      code: "stage_close_postcondition_failed",
      stage: "pass1",
    });
    expect(JSON.parse(readFileSync(resultPath, "utf8"))).toEqual(conflicting);
  });
});
