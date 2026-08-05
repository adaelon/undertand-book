// PP2 paper metadata input: same window text as Pass1 plus requested metadata fields.
//   tsx skills/build/paper-metadata-input.ts <book.md|epub> <windowId> [--book-id <id>] --content-profile paper
import { analyzePaperMetadataCandidates } from "../../packages/core/src/paper-metadata-router";
import { renderPaperMetadataModelInput } from "../../packages/core/src/model-input-renderer";
import { contentProfileUsage, parsePaperContentProfileArgsOrExit } from "./content-profile-options";
import { loadBookWindows, windowById } from "./load-book";

const parsedProfile = parsePaperContentProfileArgsOrExit(process.argv.slice(2));
const argv = parsedProfile.argv;
const positional = argv.filter((a) => !a.startsWith("--"));
const [book, idStr] = positional;
if (!book || idStr === undefined) {
  console.error(`usage: tsx paper-metadata-input.ts <book.md|epub> <windowId> [--book-id <id>] ${contentProfileUsage()}`);
  process.exit(2);
}
const id = Number(idStr);
if (!Number.isInteger(id)) {
  console.error(`windowId must be an integer, got "${idStr}"`);
  process.exit(2);
}

const { source, byLid, windows } = loadBookWindows(book);
windowById(windows, id);
const routing = analyzePaperMetadataCandidates({ windows, byLid, source });
const input = routing.packets[String(id)];
if (!input) {
  const skipped = routing.skip_reasons[String(id)];
  throw new Error(`paper metadata window ${id} is not model-eligible: ${skipped?.code ?? "not_in_plan"}`);
}

process.stdout.write(renderPaperMetadataModelInput(input));
process.stderr.write(
  `[paper-metadata-input] window ${id}: content_profile=${parsedProfile.contentProfile.id} lids=${input.visible_lids.length}\n`,
);
