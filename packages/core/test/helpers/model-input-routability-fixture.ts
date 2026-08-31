import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveAutomaticBuildTarget,
  type AutomaticBuildTarget,
} from "../../src/build-orchestrator";
import { freezeAutomaticBuildStagePolicySet } from "../../src/automatic-build-policy-generation";
import {
  collectAutomaticBuildStageQuality,
  writeAutomaticBuildStageQualityReport,
} from "../../src/automatic-build-quality";
import { markdownToBlocks } from "../../src/md-adapter";
import {
  PASS1_LID_STITCH_SCHEMA_VERSION,
  PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
  freezePass1ShadowTask,
  readPass1ShadowTask,
  writePass1ShadowCandidate,
} from "../../src/pass1-reduction";
import { segment } from "../../src/segment";
import { estimateTokens, splitWindows, type Window } from "../../src/window";
import { automaticBuildPlan } from "../../../../skills/build/automatic-build";

export const SYNTHETIC_LONG_PARAGRAPH_TOKENS = 6_992;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function asciiBodyForEstimatedTokens(tokens: number): string {
  if (!Number.isSafeInteger(tokens) || tokens < 1) {
    throw new Error("synthetic token count must be a positive safe integer");
  }
  const length = tokens * 4;
  const seed = "A deterministic sentence keeps this fixture synthetic and replayable. ";
  return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
}

export interface SyntheticRoutabilityFixture {
  root: string;
  source_file: string;
  source: string;
  paragraph_text: string;
  paragraph_lid: string;
  paragraph_tokens: number;
  blocks: ReturnType<typeof markdownToBlocks>;
  lid_nodes: ReturnType<typeof segment>;
  by_lid: Map<string, ReturnType<typeof segment>[number]>;
  windows: Window[];
  target: AutomaticBuildTarget;
  identity: {
    source_sha256: string;
    source_blocks_sha256: string;
    lid_tree_sha256: string;
    lid_spans_sha256: string;
  };
}

export function createSyntheticRoutabilityFixture(
  paragraphTokens = SYNTHETIC_LONG_PARAGRAPH_TOKENS,
): SyntheticRoutabilityFixture {
  const root = mkdtempSync(path.join(tmpdir(), "understand-book-routability-"));
  const sourceFile = path.join(root, "synthetic-routability.md");
  const paragraphText = asciiBodyForEstimatedTokens(paragraphTokens);
  const source = `# Synthetic routability\n\n${paragraphText}\n`;
  writeFileSync(sourceFile, source, "utf8");

  const blocks = markdownToBlocks(source);
  const lidNodes = segment(blocks);
  const byLid = new Map(lidNodes.map((node) => [node.lid, node]));
  const paragraph = lidNodes
    .filter((node) => node.kind === "paragraph" && node.children.length === 0)
    .sort((left, right) => (right.span.end - right.span.start) - (left.span.end - left.span.start))[0];
  if (!paragraph) throw new Error("synthetic routability fixture did not produce a paragraph LID");
  const paragraphSource = source.slice(paragraph.span.start, paragraph.span.end);
  if (paragraphSource !== paragraphText) {
    throw new Error("synthetic paragraph span does not match the generated source body");
  }
  const windows = splitWindows(lidNodes, source);
  const target = resolveAutomaticBuildTarget(sourceFile, root);
  return {
    root,
    source_file: sourceFile,
    source,
    paragraph_text: paragraphText,
    paragraph_lid: paragraph.lid,
    paragraph_tokens: estimateTokens(paragraphSource),
    blocks,
    lid_nodes: lidNodes,
    by_lid: byLid,
    windows,
    target,
    identity: {
      source_sha256: sha256(source),
      source_blocks_sha256: sha256(JSON.stringify(blocks)),
      lid_tree_sha256: sha256(JSON.stringify(lidNodes)),
      lid_spans_sha256: sha256(JSON.stringify(lidNodes.map((node) => ({ lid: node.lid, span: node.span })))),
    },
  };
}

export function writeSyntheticPass1ProductionGeneration(
  fixture: SyntheticRoutabilityFixture,
  options: { grounded?: boolean } = {},
): void {
  for (let round = 0; round < 8; round += 1) {
    const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
      requested_workers: 1,
      available_agent_slots: 1,
    });
    const pass1 = plan.snapshot.stages.find((stage) => stage.stage === "pass1");
    if (!pass1?.policy_set) throw new Error("expected a Pass1 production policy set");
    if (!pass1.pending_work_units?.length) return;
    freezeAutomaticBuildStagePolicySet(fixture.target, pass1.policy_set);
    for (const workUnit of pass1.pending_work_units) {
      const generation = pass1.generation_tasks?.[workUnit.work_unit_id];
      if (generation?.kind !== "pass1") {
        throw new Error(`missing Pass1 generation task: ${workUnit.work_unit_id}`);
      }
      const task = generation.task;
      freezePass1ShadowTask(fixture.target, task);
      const evidenceLid = task.route.evidence_lids[0];
      const nodes = options.grounded && evidenceLid
        ? [{
            id: `claim:${evidenceLid}:${task.descriptor.work_unit_id}`,
            type: "claim",
            name: "Synthetic routability fixture claim",
            occurrences: [],
            source_lid: evidenceLid,
          }]
        : [];
      const candidate = task.route.role === "whole" || task.route.role === "group"
        ? { nodes, edges: [] }
        : task.route.role === "fragment"
          ? {
              version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
              parent_lid: task.route.parent_lid,
              source_slice_ordinal: task.route.source_slice_ordinal,
              core_sha256: task.descriptor.input_basis.kind === "source_slices"
                ? task.descriptor.input_basis.slices[0].core_sha256
                : "",
              nodes,
              edges: [],
            }
          : { version: PASS1_LID_STITCH_SCHEMA_VERSION, edges: [] };
      writePass1ShadowCandidate({
        target: fixture.target,
        source: fixture.source,
        task,
        candidate,
        provenance: {
          executor: "br8-fixture",
          attempt: 1,
          generated_at: `2026-08-04T01:0${round}:00.000Z`,
        },
      });
    }
  }
  throw new Error("synthetic Pass1 production generation did not reach its close boundary");
}

export function writePass1ProductionTaskArtifact(input: {
  target: AutomaticBuildTarget;
  policy_generation_id: string;
  work_unit_id: string;
  marker?: string;
  executor?: string;
  attempt?: number;
  generated_at?: string;
}) {
  const task = readPass1ShadowTask(
    input.target,
    input.policy_generation_id,
    input.work_unit_id,
  );
  const evidenceLid = task.route.evidence_lids[0];
  const nodes = input.marker && evidenceLid
    ? [{
        id: `claim:${evidenceLid}:${sha256(`${input.work_unit_id}:${input.marker}`).slice(0, 16)}`,
        type: "claim",
        name: input.marker,
        occurrences: [],
        source_lid: evidenceLid,
      }]
    : [];
  const candidate = task.route.role === "whole" || task.route.role === "group"
    ? { nodes, edges: [] }
    : task.route.role === "fragment"
      ? {
          version: PASS1_SOURCE_FRAGMENT_SCHEMA_VERSION,
          parent_lid: task.route.parent_lid,
          source_slice_ordinal: task.route.source_slice_ordinal,
          core_sha256: task.descriptor.input_basis.kind === "source_slices"
            ? task.descriptor.input_basis.slices[0].core_sha256
            : "",
          nodes,
          edges: [],
        }
      : { version: PASS1_LID_STITCH_SCHEMA_VERSION, edges: [] };
  return writePass1ShadowCandidate({
    target: input.target,
    source: readFileSync(input.target.source_path, "utf8"),
    task,
    candidate,
    provenance: {
      executor: input.executor ?? "br8-test-executor",
      attempt: input.attempt ?? 1,
      generated_at: input.generated_at ?? "2026-08-04T00:00:00.000Z",
    },
  });
}

export function closeSyntheticPass1(fixture: SyntheticRoutabilityFixture): void {
  writeSyntheticPass1ProductionGeneration(fixture, { grounded: true });
  const plan = automaticBuildPlan(fixture.source_file, fixture.root, {
    requested_workers: 1,
    available_agent_slots: 1,
  });
  const pass1 = plan.snapshot.stages.find((stage) => stage.stage === "pass1");
  if (!pass1?.policy_set) throw new Error("expected a completed Pass1 production policy set");
  const qualityReport = collectAutomaticBuildStageQuality(fixture.target, pass1, "full");
  if (qualityReport.version !== "automatic_build_stage_quality_report.v2"
    || qualityReport.gate_status !== "passed") {
    throw new Error(`synthetic Pass1 v3 quality did not pass: ${qualityReport.gate_status}`);
  }
  writeAutomaticBuildStageQualityReport(fixture.target, qualityReport);
  writeJson(path.join(fixture.target.workspace_dir, "base.json"), {
    book_id: fixture.target.book_id,
    lid_nodes: fixture.lid_nodes,
    graph_nodes: [],
    graph_edges: [],
  });
  writeJson(path.join(fixture.target.workspace_dir, "profile_metadata.json"), {
    header: {
      book_id: fixture.target.book_id,
      profile_id: fixture.target.profile_id,
    },
  });
  writeFileSync(path.join(fixture.target.workspace_dir, "source.txt"), fixture.source, "utf8");
  writeJson(path.join(fixture.target.workspace_dir, "source_manifest.json"), {
    book_id: fixture.target.book_id,
    canonical_source: { kind: "markdown", truth_file: "source.txt" },
  });
}
