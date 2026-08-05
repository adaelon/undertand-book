// PB3/PB6 Pass2 input: emit one source-window Pass2WorkPacket as strict JSON.
//   tsx skills/build/pass2-input.ts <book.md|epub> <windowId> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]
import { renderPass2ModelInput } from "../../packages/core/src/model-input-renderer";
import { windowById } from "./load-book";
import { loadPass2BuildContext, parseBookArgs } from "./pass2-common";

const parsed = parseBookArgs(process.argv.slice(2));
const [book, idStr] = parsed.positional;
if (!book || idStr === undefined) {
  console.error("usage: tsx pass2-input.ts <book.md|epub> <windowId> [--book-id <id>] [--content-profile technical_learning|paper] [--paper-subtype research_article|survey]");
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}
const ctx = loadPass2BuildContext(book, parsed.override);
windowById(ctx.windows, id);
const packet = ctx.packets.get(id)!;
process.stdout.write(renderPass2ModelInput(packet));
process.stderr.write(`[pass2-input] window ${id}: content_profile=${parsed.contentProfile.id} candidates=${packet.candidate_targets.length} source_nodes=${packet.source_nodes.length} discourse=${packet.source_discourse.length} formula=${packet.source_formula_semantics.length}\n`);
