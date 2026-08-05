// PB5-3 跨会话续建 loop 第 2a 步 [ADR-0042]。现算单窗 Pass1 抽取输入正文(每段 [LID] 前缀)
// 打印到 stdout 喂 subagent pass1-local-extractor —— **不落盘**(输入是确定性派生,[ADR-0012])。
//   tsx skills/build/emit-input.ts <book.md|epub> <windowId> [--book-id <id>] [--content-profile technical_learning]
import { buildProfiledPass1Input } from "../../packages/core/src/pass1-profile-input";
import { renderPass1ModelInput } from "../../packages/core/src/model-input-renderer";
import { resolveAutomaticBuildTarget } from "../../packages/core/src/build-orchestrator";
import {
  readPass1ShadowTask,
  replayPass1ShadowInput,
} from "../../packages/core/src/pass1-reduction";
import { contentProfileUsage, parseContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parseContentProfileArgsOrExit(process.argv.slice(2), { allowPaperExecution: true });
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr] = positional;
const bookIdIdx = argv.indexOf("--book-id");
const override = bookIdIdx >= 0 ? argv[bookIdIdx + 1] : undefined;
const shadowGenerationIdx = argv.indexOf("--shadow-generation");
const shadowGeneration = shadowGenerationIdx >= 0 ? argv[shadowGenerationIdx + 1] : undefined;
if (shadowGenerationIdx >= 0 && (!shadowGeneration || shadowGeneration.startsWith("--"))) {
  console.error("--shadow-generation requires a policy-set SHA-256 digest");
  process.exit(2);
}
if (!book || idStr === undefined) {
  console.error(`usage: tsx emit-input.ts <book.md|epub> <windowId|workUnitId> [--book-id <id>] [--shadow-generation <policy-set-sha256>] ${contentProfileUsage()}`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
if (shadowGeneration) {
  const target = resolveAutomaticBuildTarget(book, process.cwd(), { ...(override ? { book_id: override } : {}) });
  const task = readPass1ShadowTask(target, shadowGeneration, idStr);
  const replayed = replayPass1ShadowInput({ target, source, task });
  process.stdout.write(replayed.rendered_input);
  process.stderr.write(`[emit-input] ${idStr}: shadow_generation=${shadowGeneration.slice(0, 12)} role=${replayed.route.role} content_profile=${parsedProfile.contentProfile.id}\n`);
} else {
  const id = Number(idStr);
  if (!Number.isInteger(id)) {
    console.error(`windowId 必须是整数,得到 "${idStr}"`);
    process.exit(2);
  }
  const w = windowById(windows, id);
  // 纯正文到 stdout(无前后缀),便于直接管道喂 subagent;诊断信息走 stderr。
  process.stderr.write(`[emit-input] window ${id}: ${w.leafLids.length} 叶子 content_profile=${parsedProfile.contentProfile.id}\n`);
  process.stdout.write(renderPass1ModelInput(buildProfiledPass1Input(w, byLid, source, parsedProfile.contentProfile)));
}
