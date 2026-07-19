import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  automaticBuildNext,
  automaticBuildPlan,
} from "../../../skills/build/automatic-build";
import { submitAutomaticBuildCandidate } from "../../../packages/core/src/automatic-build-mailbox";
import { automaticBuildStageArtifactPath } from "../../../packages/core/src/automatic-build-quality";
import { readAutomaticBuildAttemptSnapshot } from "../../../packages/core/src/automatic-build-task-store";
import { resolveAutomaticBuildTarget, type AutomaticBuildStage } from "../../../packages/core/src/build-orchestrator";

interface ExecutorTask {
  task_id: string;
  candidate_path: string;
  lease_ref: string;
  lease: { token: string };
  descriptor: {
    input_hash: string;
    evidence_lids: string[];
    kind: string;
  };
  input_command: string[];
}

const argv = process.argv.slice(2);
const valueArg = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const sourceWorkspace = path.resolve(valueArg("--source-workspace") ?? "");
const outputRoot = path.resolve(valueArg("--output-root") ?? "");
const sidecar = path.resolve(valueArg("--sidecar") ?? "");
if (!valueArg("--source-workspace") || !valueArg("--output-root") || !valueArg("--sidecar")) {
  throw new Error("usage: tsx replay-automatic-build-v2.ts --source-workspace <trusted-workspace> --output-root <isolated-root> --sidecar <compiled-exe>");
}
if (!existsSync(path.join(sourceWorkspace, "source_manifest.json")) || !existsSync(sidecar)) {
  throw new Error("release replay requires a trusted source workspace and compiled sidecar");
}
if (outputRoot === sourceWorkspace || outputRoot.startsWith(`${sourceWorkspace}${path.sep}`)) {
  throw new Error("release replay output must be isolated from the source workspace");
}

const bookId = path.basename(sourceWorkspace);
const replayWorkspace = path.join(outputRoot, ".understand-book", bookId);
const FOUNDATION_FILES = [
  "paper.md",
  "paper.pdf",
  "source.txt",
  "source_manifest.json",
  "pdf_source_map.json",
  "pdf_selection_map",
  "alignment_report.json",
  "base.json",
  "profile_metadata.json",
  "asset_manifest.json",
  "long_range_candidates.json",
  path.join(".build", "input"),
  path.join(".build", "source-reconciliation"),
];
const PUBLIC_DIGEST_FILES = [
  "base.json",
  "paper_metadata.json",
  "paper_lexicon.json",
  "discourse_index.json",
  "formula_semantics.json",
  "long_range_candidates.json",
  "pass2_audit.json",
  "book_structure.json",
  path.join(".build", "paper-reading-guide", "verification.json"),
];

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function filesRecursive(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const item = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursive(item));
    else if (entry.isFile()) files.push(item);
  }
  return files.sort();
}

function treeDigest(root: string): string {
  const entries = filesRecursive(root).map((file) => ({
    path: path.relative(root, file).replaceAll("\\", "/"),
    sha256: sha256(readFileSync(file)),
  }));
  return sha256(JSON.stringify(entries));
}

function copyFoundation(): void {
  if (existsSync(replayWorkspace)) rmSync(replayWorkspace, { recursive: true, force: true });
  mkdirSync(replayWorkspace, { recursive: true });
  for (const relative of FOUNDATION_FILES) {
    const source = path.join(sourceWorkspace, relative);
    if (!existsSync(source)) continue;
    const destination = path.join(replayWorkspace, relative);
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: statSync(source).isDirectory() });
  }
}

function runCommand(command: string[]): { stdout: string; stderr: string } {
  const result = spawnSync(command[0], command.slice(1), { cwd: outputRoot, encoding: "utf8", timeout: 120_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`release replay command failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function lineJson<T>(text: string, label: string): T {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${label}: `));
  if (!line) throw new Error(`release replay input is missing ${label}`);
  return JSON.parse(line.slice(label.length + 2)) as T;
}

function candidateFor(stage: AutomaticBuildStage, task: ExecutorTask, inputText: string): unknown {
  const contentHash = task.descriptor.input_hash;
  if (stage === "pass1") {
    const lid = inputText.match(/^\[([0-9.]+)\]/m)?.[1] ?? task.descriptor.evidence_lids[0];
    return {
      content_hash: contentHash,
      nodes: [{
        id: `claim:${lid}:release-replay`,
        type: "claim",
        name: `Release replay claim ${lid}`,
        occurrences: [],
        source_lid: lid,
      }],
      edges: [],
    };
  }
  if (stage === "paper_metadata") {
    const visible = lineJson<string[]>(inputText, "visible_lids");
    const requested = lineJson<string[]>(inputText, "requested_fields");
    const evidence = [visible[0]];
    const metadata = requested.includes("references")
      ? { references: { value: [{ raw: "Deterministic release replay reference" }], source: "paper_text", evidence_lids: evidence } }
      : { title: { value: "Understanding Transformer", source: "paper_text", evidence_lids: evidence } };
    return { content_hash: contentHash, metadata };
  }
  if (stage === "paper_lexicon") {
    const clusters = lineJson<Array<{
      surface_forms: string[];
      occurrence_lids: string[];
      definition_lids: string[];
      suggested_term_types: string[];
    }>>(inputText, "candidate_clusters");
    const cluster = clusters[0];
    return {
      content_hash: contentHash,
      entries: [{
        term: cluster.surface_forms[0],
        term_type: cluster.suggested_term_types[0] ?? "domain_term",
        occurrences_lids: cluster.occurrence_lids,
        ...(cluster.definition_lids[0] && cluster.occurrence_lids.includes(cluster.definition_lids[0])
          ? { defined_at_lid: cluster.definition_lids[0] }
          : {}),
      }],
    };
  }
  if (stage === "profile_sidecar") {
    const visible = lineJson<string[]>(inputText, "visible_lids");
    const formulaLids = lineJson<string[]>(inputText, "formula_lids");
    if (formulaLids.length) {
      const formulaLid = formulaLids[0];
      return {
        content_hash: contentHash,
        discourse_items: [],
        formula_semantics: [{
          formula_lid: formulaLid,
          context_lids: visible,
          composition: {
            source_lid: formulaLid,
            meaning: "Records a deterministic relation grounded in the formula.",
            terms: [],
            evidence_lids: [formulaLid],
          },
        }],
      };
    }
    return {
      content_hash: contentHash,
      discourse_items: [{ lid: visible[0], mode: "informative", local_function: "description", relations: [] }],
      formula_semantics: [],
    };
  }
  if (stage === "pass2") {
    const packet = JSON.parse(inputText) as { candidate_targets: Array<{ candidate_id: string }> };
    return {
      content_hash: contentHash,
      output: {
        accepted_edges: [],
        pending_edges: [],
        rejected_candidates: packet.candidate_targets.map((candidate) => ({
          candidate_id: candidate.candidate_id,
          reason: "weak_retrieval_value",
        })),
      },
    };
  }
  if (stage === "book_structure") {
    const packet = JSON.parse(inputText) as {
      job_id: string;
      unit_lid?: string;
      leaf_lids?: string[];
      unit_cards?: Array<{
        unit_lid: string;
        role: string;
        summary: { text: string; evidence_lids: string[] };
        depends_on: string[];
      }>;
    };
    if (packet.job_id === "stitch") {
      return {
        content_hash: contentHash,
        output: {
          spine: (packet.unit_cards ?? []).map((card) => ({
            lid: card.unit_lid,
            role: card.role,
            summary: card.summary,
            key_stop_ids: [],
            depends_on: card.depends_on,
          })),
          throughlines: [],
          key_stops: [],
        },
      };
    }
    const evidence = packet.leaf_lids?.[0] ?? packet.unit_lid!;
    return {
      content_hash: contentHash,
      output: {
        unit_card: {
          unit_lid: packet.unit_lid,
          role: "foundation",
          summary: { text: `Deterministic release unit ${packet.unit_lid}`, evidence_lids: [evidence] },
          candidate_key_stops: [],
          depends_on: [],
          evidence_lids: [evidence],
        },
      },
    };
  }
  throw new Error(`release replay has no fake executor for ${stage}`);
}

function outputCounts(stage: AutomaticBuildStage, payload: unknown): Record<string, number> {
  const value = payload as Record<string, any>;
  if (stage === "pass1") return { nodes: value.nodes.length, edges: value.edges.length };
  if (stage === "paper_metadata") return { fields: Object.keys(value.metadata).length };
  if (stage === "paper_lexicon") return { entries: value.entries.length };
  if (stage === "profile_sidecar") return {
    discourse_items: value.discourse_items.length,
    formula_semantics: value.formula_semantics.length,
  };
  if (stage === "pass2") return {
    dispositions: value.output.accepted_edges.length + value.output.pending_edges.length + value.output.rejected_candidates.length,
  };
  if (stage === "book_structure") return { outputs: 1 };
  return {};
}

function semanticStage(stage: AutomaticBuildStage): Exclude<AutomaticBuildStage, "paper_reading_guide"> {
  if (stage === "paper_reading_guide") throw new Error("paper_reading_guide has no executor artifact");
  return stage;
}

function executeTasks(targetInput: string, rootDir: string, stage: AutomaticBuildStage, tasks: ExecutorTask[], trace: unknown[]): void {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  for (const task of tasks) {
    const input = runCommand(task.input_command).stdout;
    const payload = candidateFor(stage, task, input);
    writeFileSync(task.candidate_path, JSON.stringify(payload), "utf8");
    const artifactPath = automaticBuildStageArtifactPath(target, semanticStage(stage), task.task_id);
    const receipt = submitAutomaticBuildCandidate(
      target,
      task.lease_ref,
      task.lease.token,
      task.candidate_path,
      (candidatePath) => {
        mkdirSync(path.dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, readFileSync(candidatePath));
        return { artifact_path: artifactPath, output_counts: outputCounts(stage, payload) };
      },
    );
    trace.push({
      kind: "receipt",
      stage,
      task_ref: receipt.task_ref,
      state: receipt.state,
      artifact_sha256: receipt.artifact_sha256,
    });
  }
}

function jsonFiles(root: string): unknown[] {
  return filesRecursive(root).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(file, "utf8")));
}

function collectReport(targetInput: string, rootDir: string, trace: unknown[], stageSequence: string[]) {
  const target = resolveAutomaticBuildTarget(targetInput, rootDir);
  const attemptSnapshot = readAutomaticBuildAttemptSnapshot(target);
  const attempts = Object.values(attemptSnapshot.stages).flatMap((stage) => Object.values(stage ?? {}));
  const stageArtifactRoots = ["pass1", "paper-metadata", "paper-lexicon", "profile-sidecar", "pass2", "book-structure"];
  const artifactHashes = stageArtifactRoots.flatMap((relative) => jsonFiles(path.join(target.workspace_dir, ".build", relative)))
    .flatMap((value: any) => value.version === "semantic_task_artifact.v2"
      ? [{ stage: value.stage, work_unit_id: value.work_unit_id, artifact_hash: value.artifact_hash }]
      : [])
    .sort((left, right) => `${left.stage}:${left.work_unit_id}`.localeCompare(`${right.stage}:${right.work_unit_id}`));
  const quality = jsonFiles(path.join(target.workspace_dir, ".build", "automatic-build", "v2", "quality"))
    .map((value: any) => ({ stage: value.stage, digest: value.digest, gate_status: value.gate_status }))
    .sort((left, right) => left.stage.localeCompare(right.stage));
  const policies = jsonFiles(path.join(target.workspace_dir, ".build", "automatic-build", "v2", "policies"))
    .map((value: any) => ({ stage: value.stage, policy_digest: value.policy_digest }))
    .sort((left, right) => left.stage.localeCompare(right.stage));
  const publications = jsonFiles(path.join(target.workspace_dir, ".build", "automatic-build", "v2", "publication"))
    .flatMap((value: any) => value.version === "automatic_build_publication_receipt.v1"
      ? [{ stage: value.stage, transaction_id: value.transaction_id }]
      : [])
    .sort((left, right) => left.stage.localeCompare(right.stage));
  const metrics = jsonFiles(path.join(target.workspace_dir, ".build", "automatic-build", "v2", "metrics"))
    .map((value: any) => ({
      stage: value.stage,
      attempt_count: value.attempt_count,
      work_unit_count: value.work_unit_count,
      status_counts: value.status_counts,
      known_usage_coverage: value.usage?.known_usage_coverage,
      unavailable_attempts: value.usage?.unavailable_attempts,
    }))
    .sort((left, right) => left.stage.localeCompare(right.stage));
  const publicArtifacts = PUBLIC_DIGEST_FILES.filter((relative) => existsSync(path.join(target.workspace_dir, relative)))
    .map((relative) => ({ path: relative.replaceAll("\\", "/"), sha256: sha256(readFileSync(path.join(target.workspace_dir, relative))) }));
  const traceText = JSON.stringify(trace);
  if (/candidate_path|formula_semantics|"nodes"|"edges"/.test(traceText)) {
    throw new Error("release replay root trace contains candidate payload or candidate path");
  }
  const report = {
    version: "automatic_build_v2_real_paper_replay.v1",
    protocol: "automatic_build_protocol.v2",
    target: {
      book_id: target.target_ref.book_id,
      profile_id: target.target_ref.profile_id,
      input_fingerprint: target.target_ref.input_fingerprint,
    },
    stage_sequence: stageSequence,
    policies,
    artifact_hashes: artifactHashes,
    quality,
    publications,
    public_artifacts: publicArtifacts,
    attempts: {
      count: attempts.length,
      all_first_attempt_success: attempts.every((attempt) => attempt.last_attempt === 1 && attempt.failures === 0),
    },
    metrics,
    forbidden_state: {
      fake_source_workspace: existsSync(path.join(rootDir, ".understand-book", "source")),
      shared_attempts_ledger: existsSync(path.join(target.workspace_dir, ".build", "automatic-build", "attempts.json")),
      trace_candidate_relay: false,
    },
  };
  return { ...report, digest: sha256(JSON.stringify(report)) };
}

function runReplay(iteration: number) {
  copyFoundation();
  process.env.UNDERSTAND_BOOK_SIDECAR_SELF = sidecar;
  const trace: unknown[] = [];
  const stageSequence: string[] = [];
  for (let step = 0; step < 2_000; step += 1) {
    const plan = automaticBuildPlan(replayWorkspace, outputRoot, {
      requested_workers: 3,
      available_agent_slots: 3,
      quality_profile: "full",
    });
    const next = automaticBuildNext(replayWorkspace, outputRoot, 3, {
      owner: `release-replay-${iteration}`,
      lease_ttl_ms: 3_600_000,
      available_agent_slots: 3,
      quality_profile: "full",
      ...(plan.preflight ? { accepted_plan_digest: plan.preflight.plan_digest } : {}),
    });
    const action = next.action as any;
    trace.push({ kind: "action", action: action.kind, stage: action.stage ?? null, reason: action.reason ?? null });
    if (action.kind === "extract") {
      stageSequence.push(action.stage);
      executeTasks(replayWorkspace, outputRoot, action.stage, action.tasks as ExecutorTask[], trace);
    } else if (action.kind === "close_stage") {
      stageSequence.push(`close:${action.stage}`);
      runCommand(action.command);
    } else if (action.kind === "done") {
      stageSequence.push("done");
      const report = collectReport(replayWorkspace, outputRoot, trace, stageSequence);
      writeFileSync(path.join(outputRoot, `replay-${iteration}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return report;
    } else {
      throw new Error(`release replay stopped before done: ${JSON.stringify(action)}`);
    }
  }
  throw new Error("release replay exceeded 2000 scheduler steps");
}

mkdirSync(outputRoot, { recursive: true });
const originalBefore = treeDigest(sourceWorkspace);
const first = runReplay(1);
const second = runReplay(2);
const originalAfter = treeDigest(sourceWorkspace);
if (originalBefore !== originalAfter) throw new Error("release replay modified the original real-paper workspace");
if (JSON.stringify({ ...first, digest: undefined }) !== JSON.stringify({ ...second, digest: undefined })) {
  throw new Error(`isolated real-paper replay diverged:\nFIRST=${JSON.stringify(first)}\nSECOND=${JSON.stringify(second)}`);
}
if (!first.attempts.all_first_attempt_success || first.forbidden_state.fake_source_workspace
  || first.forbidden_state.shared_attempts_ledger || first.forbidden_state.trace_candidate_relay) {
  throw new Error(`release replay violated execution invariants: ${JSON.stringify(first)}`);
}
const comparison = {
  version: "automatic_build_v2_replay_comparison.v1",
  source_workspace_digest: originalBefore,
  first_digest: first.digest,
  second_digest: second.digest,
  identical: first.digest === second.digest,
  original_workspace_unchanged: originalBefore === originalAfter,
};
writeFileSync(path.join(outputRoot, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`, "utf8");
console.log(JSON.stringify(comparison, null, 2));
