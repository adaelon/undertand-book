// PB5-3 跨会话续建 loop 第 2c 步 [ADR-0042]。subagent 抽完一窗 → **原子写**该窗产物。
//   tsx skills/build/pass1-write.ts <book.md|epub> <windowId> <subagent-output.json> [--book-id <id>] [--content-profile technical_learning]
// subagent-output.json = {nodes, edges}(Pass1Output)。content_hash 由 TS 从窗口重算(命门:
// 不信调用方手算),临时文件 + rename 原子落 `.understand-book/<bookId>/.build/pass1/<id>.json`。
// 逐窗原子写是跨会话续建命根:抽一窗落一窗,会话可停在任意窗、已抽全部幸存。
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { buildPass1Artifact } from "../../packages/core/src/build-resume";
import { deriveBookId } from "../../packages/core/src/book-id";
import { resolveAutomaticBuildTarget } from "../../packages/core/src/build-orchestrator";
import {
  assertPass1ShadowCandidatePath,
  readPass1ShadowTask,
  writePass1ShadowCandidate,
} from "../../packages/core/src/pass1-reduction";
import type { Pass1Output } from "../../packages/core/src/merge";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr, outputPath] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const shadowGenerationIdx = argv.indexOf("--shadow-generation");
const shadowGeneration = shadowGenerationIdx >= 0 ? argv[shadowGenerationIdx + 1] : undefined;
if (shadowGenerationIdx >= 0 && (!shadowGeneration || shadowGeneration.startsWith("--"))) {
  console.error("--shadow-generation requires a policy-set SHA-256 digest");
  process.exit(2);
}
if (!book || idStr === undefined || !outputPath) {
  console.error(`usage: tsx pass1-write.ts <book.md|epub> <windowId|workUnitId> <subagent-output.json> [--book-id <id>] [--shadow-generation <policy-set-sha256>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
if (shadowGeneration) {
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
  const task = readPass1ShadowTask(target, shadowGeneration, idStr);
  const candidatePath = assertPass1ShadowCandidatePath({ target, task, candidate_path: outputPath });
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8").replace(/^\uFEFF/, ""));
  const attemptIdx = argv.indexOf("--attempt");
  const attempt = Number(attemptIdx >= 0 ? argv[attemptIdx + 1] : "1");
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("--attempt must be a positive safe integer");
  const generatedAtIdx = argv.indexOf("--generated-at");
  const generatedAt = generatedAtIdx >= 0 ? argv[generatedAtIdx + 1] : new Date().toISOString();
  if (!generatedAt || generatedAt.startsWith("--") || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("--generated-at must be an ISO timestamp");
  }
  const executorIdx = argv.indexOf("--executor");
  const executor = executorIdx >= 0 ? argv[executorIdx + 1] : "codex-shadow-executor";
  if (!executor || executor.startsWith("--")) throw new Error("--executor requires a value");
  const modelIdx = argv.indexOf("--model");
  const model = modelIdx >= 0 ? argv[modelIdx + 1] : undefined;
  if (modelIdx >= 0 && (!model || model.startsWith("--"))) throw new Error("--model requires a value");
  const result = writePass1ShadowCandidate({
    target,
    source,
    task,
    candidate,
    provenance: {
      executor,
      ...(model ? { model } : {}),
      attempt,
      generated_at: generatedAt,
    },
  });
  console.log(JSON.stringify(result));
} else {
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
    console.error(`windowId 必须是整数,得到 "${idStr}"`);
    process.exit(2);
  }
  const w = windowById(windows, id);
  const output = JSON.parse(readFileSync(outputPath, "utf8")) as Pass1Output;
  const artifact = buildPass1Artifact(w, byLid, source, output, parsedProfile.contentProfile);

  const bookId = deriveBookId(book, override);
  const dir = `.understand-book/${bookId}/.build/pass1`;
  mkdirSync(dir, { recursive: true });
  const finalPath = `${dir}/${id}.json`;
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(artifact), "utf8");
  renameSync(tmpPath, finalPath); // 原子替换:中断不留半成品

  console.log(
    `[pass1-write] window ${id} → ${finalPath}  content_profile=${parsedProfile.contentProfile.id} nodes=${artifact.nodes.length} edges=${artifact.edges.length} hash=${artifact.content_hash.slice(0, 12)}`,
  );
}
