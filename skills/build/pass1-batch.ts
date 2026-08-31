// PB5-3c 跨会话续建收口 [ADR-0042]:消费 `.build/pass1/*.json` 累积(content-hash 校验)→
// merge+闸 → 锚定率 → 固化只读基座。pending(缺窗 / hash 失配)默认**拒绝收口**(缺窗=缺节点=
// 图不完整),`--allow-partial` 显式兜底。本脚本零 LLM,是续建 loop 的末步(全 done 后收口)。
//   tsx pass1-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial]
//     [--content-profile technical_learning] [--formula-candidates <p>] [--discourse-candidates <p>] [--pass2-output <p>]
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { mergeAndGate, type Pass1Output } from "../../packages/core/src/merge";
import { projectCatalog } from "../../packages/core/src/catalog";
import { AssetManifestZ, FormulaSemanticsSidecarZ, Pass2BuildAuditSidecarZ, ReadOnlyBaseZ, SourceManifestZ, TechnicalLearningDiscourseIndexZ } from "../../packages/core/src/zod";
import { buildProfileMetadata, buildReproducibleProfileArtifactHeader } from "../../packages/core/src/profile-artifact";
import { buildSourceManifest } from "../../packages/core/src/source-manifest";
import { buildAssetManifest } from "../../packages/core/src/asset-manifest";
import { buildFormulaSemanticsSidecar, type FormulaSemanticsBuildCandidate } from "../../packages/core/src/formula-semantics";
import { buildTechnicalLearningDiscourseIndex, type TechnicalLearningDiscourseItem } from "../../packages/core/src/discourse-index";
import { buildLidToWindowIndex, buildLongRangeCandidates, gatePass2BuildOutput, type Pass2LlmOutput } from "../../packages/core/src/pass2-build";
import { deriveBookId } from "../../packages/core/src/book-id";
import { computeBuildStatus, type Pass1Artifact } from "../../packages/core/src/build-resume";
import {
  semanticArtifactPayload,
  type ExtractionQualityProfile,
} from "../../packages/core/src/semantic-artifact";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";
import { assertTrustedPaperProjectionSource } from "../../packages/core/src/paper-projection-chain";
import path from "node:path";
import {
  buildAutomaticBuildStageBatchResult,
  publishAutomaticBuildArtifactSet,
} from "../../packages/core/src/automatic-build-publication";
import {
  buildAutomaticBuildSnapshot,
  resolveAutomaticBuildTarget,
} from "../../packages/core/src/build-orchestrator";
import { collectAutomaticBuildStageQuality } from "../../packages/core/src/automatic-build-quality";
import { canonicalAutomaticBuildJson } from "../../packages/core/src/automatic-build-protocol";
import {
  assertPass1ShadowCandidatePath,
  readPass1ShadowTask,
  writePass1ShadowFinalCandidate,
} from "../../packages/core/src/pass1-reduction";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const VALUE_FLAGS = new Set([
  "--book-id",
  "--formula-candidates",
  "--discourse-candidates",
  "--pass2-output",
  "--original-pdf",
  "--pdf-source-map",
  "--preserve-foundation",
  "--shadow-generation",
  "--shadow-final",
  "--production-policy-contracts",
  "--quality-profile",
]);
const opts: Record<string, string | undefined> = {};
let allowPartial = false;
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--allow-partial") allowPartial = true;
  else if (VALUE_FLAGS.has(a)) opts[a] = argv[++i];
  else if (a.startsWith("--")) { console.error(`未知选项 ${a}`); process.exit(2); }
  else positional.push(a);
}
const book = positional[0];
if (!book) {
  console.error(`usage: tsx pass1-batch.ts <book.md|epub> [--book-id <id>] [--allow-partial] ${contentProfileUsage()} [--original-pdf <paper.pdf>] [--pdf-source-map <map.json>] [--formula-candidates <p>] [--discourse-candidates <p>] [--pass2-output <p>]`);
  process.exit(2);
}
const formulaCandidatesPath = opts["--formula-candidates"];
const discourseCandidatesPath = opts["--discourse-candidates"];
const pass2OutputPath = opts["--pass2-output"];
const originalPdfPath = opts["--original-pdf"];
const pdfSourceMapPath = opts["--pdf-source-map"];
const preserveFoundationPath = opts["--preserve-foundation"];
const shadowGeneration = opts["--shadow-generation"];
const shadowFinal = opts["--shadow-final"];
const productionPolicyContractsJson = opts["--production-policy-contracts"];
const productionQualityProfile = opts["--quality-profile"] ?? "full";
if (!( ["full", "balanced", "sparse"] as string[]).includes(productionQualityProfile)) {
  throw new Error(`unsupported --quality-profile ${productionQualityProfile}`);
}
if (Boolean(shadowGeneration) !== Boolean(shadowFinal)) {
  console.error("--shadow-generation and --shadow-final must be provided together");
  process.exit(2);
}
if (productionPolicyContractsJson && (shadowGeneration || shadowFinal)) {
  throw new Error("--production-policy-contracts cannot be combined with --shadow-generation/--shadow-final");
}

const { source, blocks, lidNodes, byLid, windows } = loadBookWindows(book);
const bookId = deriveBookId(book, opts["--book-id"]);
const outputDir = path.resolve(`.understand-book/${bookId}`);
if (shadowGeneration && shadowFinal) {
  if (allowPartial) throw new Error("--allow-partial is not valid for a shadow final candidate");
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { book_id: bookId });
  const task = readPass1ShadowTask(target, shadowGeneration, shadowFinal);
  const result = writePass1ShadowFinalCandidate({ target, source, task });
  console.log(JSON.stringify({
    version: result.version,
    work_unit_id: result.work_unit_id,
    window_id: result.window_id,
    candidate_path: result.candidate_path,
    candidate_sha256: result.candidate_sha256,
  }));
  process.exit(0);
}
if (preserveFoundationPath) {
  if (parsedProfile.contentProfile.id !== "paper") {
    throw new Error("--preserve-foundation is only valid for content_profile=paper");
  }
  if (path.resolve(preserveFoundationPath) !== outputDir) {
    throw new Error(`--preserve-foundation must equal the target workspace ${outputDir}`);
  }
  const trusted = assertTrustedPaperProjectionSource(outputDir);
  if (path.resolve(book) !== path.resolve(trusted.trusted_source_path)) {
    throw new Error(`paper Pass1 must consume the trusted workspace source.txt: ${trusted.trusted_source_path}`);
  }
}

// 消费 `.build/pass1/<id>.json`:逐窗读已落产物(缺文件=不入 map)
const pass1Dir = `.understand-book/${bookId}/.build/pass1`;
const artifacts = new Map<number, Pass1Artifact>();
let done: number[];
let pending: number[];
if (productionPolicyContractsJson) {
  if (allowPartial) throw new Error("--allow-partial is not valid for a production v3 generation");
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { book_id: bookId });
  if (path.resolve(target.workspace_dir) !== outputDir) {
    throw new Error("production Pass1 target does not match its resolved output workspace");
  }
  const snapshot = buildAutomaticBuildSnapshot(target, {
    quality_profile: productionQualityProfile as ExtractionQualityProfile,
  });
  const stage = snapshot.stages.find((candidate) => candidate.stage === "pass1");
  const expectedPolicyContracts = JSON.parse(productionPolicyContractsJson) as unknown;
  const currentPolicyContracts = stage?.policy_set?.members.map((member) => ({
    kind: member.kind,
    policy_generation_id: member.policy_generation_id,
    semantic_contract: member.semantic_contract,
  }));
  if (!stage?.policy_set
    || canonicalAutomaticBuildJson(currentPolicyContracts)
      !== canonicalAutomaticBuildJson(expectedPolicyContracts)) {
    throw new Error("production Pass1 generation does not match the current policy set");
  }
  if (stage.pending_tasks.length) {
    throw new Error("production Pass1 generation still has pending work units");
  }
  const contributors = stage.quality_routing?.public_contributors ?? [];
  if (!contributors.length) throw new Error("production Pass1 generation has no public contributors");
  for (const contributor of contributors) {
    const generation = stage.generation_tasks?.[contributor.work_unit_id];
    if (generation?.kind !== "pass1") {
      throw new Error(`production Pass1 contributor has no frozen task: ${contributor.work_unit_id}`);
    }
    const task = readPass1ShadowTask(
      target,
      generation.task.policy_generation_id,
      contributor.work_unit_id,
    );
    const result = writePass1ShadowFinalCandidate({ target, source, task });
    const candidatePath = assertPass1ShadowCandidatePath({
      target,
      task,
      candidate_path: result.candidate_path,
    });
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8")) as Pass1Artifact;
    if (typeof candidate.content_hash !== "string"
      || !Array.isArray(candidate.nodes)
      || !Array.isArray(candidate.edges)) {
      throw new Error(`production Pass1 public candidate is invalid: ${contributor.work_unit_id}`);
    }
    if (artifacts.has(result.window_id)) {
      throw new Error(`production Pass1 window has duplicate public contributors: ${result.window_id}`);
    }
    artifacts.set(result.window_id, candidate);
  }
  if (artifacts.size !== windows.length) {
    throw new Error("production Pass1 contributors do not cover every current window");
  }
  const qualityReport = collectAutomaticBuildStageQuality(
    target,
    stage,
    productionQualityProfile as ExtractionQualityProfile,
  );
  if (qualityReport.gate_status !== "passed") {
    throw new Error(`production Pass1 quality gate did not pass: ${qualityReport.gate_status}`);
  }
  done = windows.map((window) => window.id);
  pending = [];
} else {
  for (const w of windows) {
    const f = `${pass1Dir}/${w.id}.json`;
    if (existsSync(f)) artifacts.set(w.id, semanticArtifactPayload<Pass1Artifact>(JSON.parse(readFileSync(f, "utf8"))));
  }
  // Legacy resume artifacts use the original whole-window body hash as their freshness proof.
  ({ done, pending } = computeBuildStatus(
    windows,
    byLid,
    source,
    artifacts,
    parsedProfile.contentProfile,
  ));
}
if (pending.length && !allowPartial) {
  console.error(`[pass1-batch] 拒绝收口:${pending.length}/${windows.length} 窗 pending(缺窗=缺节点=图不完整)`);
  console.error(`  pending ids: ${pending.join(",")}`);
  console.error(`  续建: build-status 看待抽窗 → 逐窗 emit-input+抽取+pass1-write;全 done 后重跑。强行收口加 --allow-partial`);
  process.exit(1);
}

// 只把 done 窗口的抽取产物喂 merge(--allow-partial 下 pending 窗口跳过,基座局部)
const outputs: Pass1Output[] = done.map((id) => {
  const a = artifacts.get(id)!;
  return { nodes: a.nodes, edges: a.edges };
});

const { nodes, edges, report } = mergeAndGate(outputs, lidNodes);
const catalog = projectCatalog(nodes);

// 局部锚定率:分母 = done 窗口叶子并集
const idxs = done;
const sampledLeaves = new Set(idxs.flatMap((id) => windowById(windows, id).leafLids));
const anchored = new Set<string>();
for (const n of nodes) {
  if (n.type === "claim") { if (n.source_lid) anchored.add(n.source_lid); }
  else for (const l of n.occurrences) anchored.add(l);
}
const sampledAnchored = [...sampledLeaves].filter((l) => anchored.has(l)).length;
const sampledRate = sampledLeaves.size ? sampledAnchored / sampledLeaves.size : 0;

// 固化小基座 + zod 校验(bookId 已在头部派生)
const profileHeader = buildReproducibleProfileArtifactHeader({ book_id: bookId, content_profile: parsedProfile.contentProfile.id });
const profileMetadata = buildProfileMetadata(profileHeader);
const sourceManifest = preserveFoundationPath
  ? null
  : buildSourceManifest({
      book_id: bookId,
      source_path: book,
      original_pdf_path: originalPdfPath,
      pdf_source_map_path: pdfSourceMapPath,
    });
if (sourceManifest) SourceManifestZ.parse(sourceManifest);
const formulaSidecar = formulaCandidatesPath
  ? buildFormulaSemanticsSidecar(
      profileHeader,
      JSON.parse(readFileSync(formulaCandidatesPath, "utf8")) as FormulaSemanticsBuildCandidate[],
      lidNodes,
    )
  : null;
if (formulaSidecar) FormulaSemanticsSidecarZ.parse(formulaSidecar.sidecar);
const discourseSidecar = discourseCandidatesPath
  ? buildTechnicalLearningDiscourseIndex(
      profileHeader,
      JSON.parse(readFileSync(discourseCandidatesPath, "utf8")) as TechnicalLearningDiscourseItem[],
      lidNodes,
    )
  : null;
if (discourseSidecar) TechnicalLearningDiscourseIndexZ.parse(discourseSidecar.sidecar);

// PB3-5: Pass2 长程边 —— 确定性候选(build-only)+ 可选 subagent 输出过 gate 写回
const lidToWindowIndex = buildLidToWindowIndex(windows);
const candidateIndex = {
  candidates: buildLongRangeCandidates({
    graphNodes: nodes,
    lidToWindowIndex,
    discourseIndex: discourseSidecar?.sidecar,
    formulaSemantics: formulaSidecar?.sidecar.items,
  }),
};
const pass2Gated = pass2OutputPath
  ? gatePass2BuildOutput(
      JSON.parse(readFileSync(pass2OutputPath, "utf8")) as Pass2LlmOutput,
      profileHeader,
      nodes,
      lidNodes,
      lidToWindowIndex,
    )
  : null;
if (pass2Gated) Pass2BuildAuditSidecarZ.parse(pass2Gated.audit); // 产出前自检
const longRangeEdges = pass2Gated?.edges ?? [];

// long_range 边合并进 base 后统一固化(local + long_range)
const base = { book_id: bookId, lid_nodes: lidNodes, graph_nodes: nodes, graph_edges: [...edges, ...longRangeEdges] };
ReadOnlyBaseZ.parse(base); // 产出前自检(字段失配抛错)
const dir = `.understand-book/${bookId}`;
mkdirSync(dir, { recursive: true });
const assetManifest = buildAssetManifest({
  book_id: bookId,
  book_path: book,
  output_dir: dir,
  source_blocks: blocks,
  lid_nodes: lidNodes,
});
AssetManifestZ.parse(assetManifest);
const publicArtifacts: Record<string, string> = {
  "base.json": JSON.stringify(base, null, 2),
  "profile_metadata.json": JSON.stringify(profileMetadata, null, 2),
  "asset_manifest.json": JSON.stringify(assetManifest, null, 2),
  // build-only:不被 Book::load 读,供 Pass2 prompt 输入 + 覆盖/审计调试 `[PB3 grill §2]`
  "long_range_candidates.json": JSON.stringify(candidateIndex, null, 2),
};
if (!preserveFoundationPath) publicArtifacts["source.txt"] = source;
if (sourceManifest) publicArtifacts["source_manifest.json"] = JSON.stringify(sourceManifest, null, 2);
if (formulaSidecar) publicArtifacts["formula_semantics.json"] = JSON.stringify(formulaSidecar.sidecar, null, 2);
if (discourseSidecar) publicArtifacts["discourse_index.json"] = JSON.stringify(discourseSidecar.sidecar, null, 2);
if (pass2Gated) publicArtifacts["pass2_audit.json"] = JSON.stringify(pass2Gated.audit, null, 2);
const publicationReceipt = publishAutomaticBuildArtifactSet({
  workspace_dir: dir,
  stage: "pass1",
  artifacts: publicArtifacts,
});
if (preserveFoundationPath) assertTrustedPaperProjectionSource(outputDir);

console.error(`[pass1-batch] ${book}  bookId=${bookId}  content_profile=${parsedProfile.contentProfile.id}${allowPartial && pending.length ? "  [--allow-partial]" : ""}`);
console.error(`  窗口=${windows.length}  done=${done.length}  pending=${pending.length}  全书叶子=${lidNodes.filter((n) => n.children.length === 0).length}`);
console.error(`  抽取输入: nodes=${outputs.reduce((s, o) => s + o.nodes.length, 0)} edges=${outputs.reduce((s, o) => s + o.edges.length, 0)}`);
console.error(`  merge 合并: 节点合并=${report.nodesMerged} 边去重=${report.edgesDeduped}`);
console.error(`  闸后: nodes=${report.nodesOut} edges=${report.edgesOut} 目录=${catalog.length}`);
console.error(`  丢弃: 节点=${report.droppedNodes.length} 边=${report.droppedEdges.length} 剔除occ=${report.prunedOccurrences.length}`);
console.error(`  锚定率(全书分母)=${(report.anchorRate * 100).toFixed(4)}%`);
console.error(`  锚定率(已抽窗口分母,${sampledAnchored}/${sampledLeaves.size})=${(sampledRate * 100).toFixed(2)}%`);
console.error(`  基座固化: ${dir}/base.json  (zod 校验通过)`);
console.error(`  profile metadata: ${dir}/profile_metadata.json`);
if (sourceManifest) {
  console.error(
    `  source manifest: ${dir}/source_manifest.json canonical=${sourceManifest.canonical_source.kind} pdf_attachments=${sourceManifest.attachments.length}`,
  );
} else {
  console.error(`  source manifest: ${dir}/source_manifest.json preserved reconciled foundation`);
}
console.error(
  `  asset manifest: ${dir}/asset_manifest.json images=${assetManifest.images.length} available=${assetManifest.images.filter((img) => img.status === "available").length}`,
);
if (formulaSidecar) {
  console.error(
    `  formula semantics: ${dir}/formula_semantics.json items=${formulaSidecar.sidecar.items.length} pending=${formulaSidecar.pending.length}`,
  );
}
if (discourseSidecar) {
  console.error(
    `  discourse index: ${dir}/discourse_index.json items=${discourseSidecar.sidecar.items.length} dropped=${discourseSidecar.dropped.length}`,
  );
}
console.error(`  long_range candidates: ${dir}/long_range_candidates.json candidates=${candidateIndex.candidates.length}`);
if (pass2Gated) {
  console.error(
    `  pass2 audit: ${dir}/pass2_audit.json long_range_edges=${pass2Gated.edges.length} accepted=${pass2Gated.audit.accepted.length} pending=${pass2Gated.audit.pending.length} rejected=${pass2Gated.audit.rejected.length} gate_dropped=${pass2Gated.audit.gate_dropped.length}`,
  );
}
process.stdout.write(`${JSON.stringify(buildAutomaticBuildStageBatchResult(publicationReceipt))}\n`);
