import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows, type WindowBudget } from "../src/window";
import { buildPass1Input } from "../src/pass1-input";
import { pass1ContentHash, type Pass1ArtifactMeta } from "../src/build-resume";
import { resolveContentProfile } from "../src/content-profile";
import {
  buildProfileSidecarArtifact,
  buildProfileSidecarWindowInput,
  computeProfileSidecarStatus,
} from "../src/profile-sidecar-build";

const md = [
  "# Chapter",
  "",
  "Definition paragraph.",
  "Inline formula $F=ma$ inside text.",
  "",
  "$$ E = mc^2 $$",
  "",
  "Explanation paragraph.",
].join("\n");
const nodes = segment(markdownToBlocks(md));
const byLid = new Map(nodes.map((n) => [n.lid, n]));
const windows = splitWindows(nodes, md, { maxInputTokens: 20, maxLeavesSoft: 1 } satisfies WindowBudget);

describe("PB6 profile-sidecar build helpers", () => {
  it("derives formula_lids deterministically from LidNode.kind", () => {
    const formulaWindow = windows.find((w) => w.leafLids.some((lid) => byLid.get(lid)?.kind === "formula"));
    expect(formulaWindow).toBeTruthy();
    const input = buildProfileSidecarWindowInput(formulaWindow!, byLid, md);
    expect(input.visible_lids).toEqual(formulaWindow!.leafLids);
    expect(input.formula_lids).toEqual(formulaWindow!.leafLids.filter((lid) => byLid.get(lid)?.kind === "formula"));
    expect(input.text).toContain(`[${input.formula_lids[0]}]`);
    expect(nodes.filter((n) => n.kind === "formula")).toHaveLength(2);
  });

  it("builds a normalized artifact with the same content_hash口径 as Pass1 input", () => {
    const w = windows[0];
    const artifact = buildProfileSidecarArtifact(w, byLid, md, {
      discourse_items: [
        {
          lid: w.leafLids[0],
          mode: "informative",
          local_function: "definition",
          rhetorical_move: "main_point",
          local_summary: "Defines the local idea.",
          relations: [],
        },
      ],
    });
    expect(artifact.content_hash).toBe(pass1ContentHash(buildPass1Input(w, byLid, md)));
    expect(artifact.discourse_items).toHaveLength(1);
    expect(artifact.formula_semantics).toEqual([]);
  });

  it("adds paper discourse rules and binds profile-sidecar hash to the profile", () => {
    const w = windows[0];
    const paper = resolveContentProfile("paper", { paper_subtype: "survey" });
    const technical = resolveContentProfile("technical_learning");
    const technicalInput = buildProfileSidecarWindowInput(w, byLid, md, technical);
    const paperInput = buildProfileSidecarWindowInput(w, byLid, md, paper);

    expect(technicalInput.text).toBe(buildPass1Input(w, byLid, md).text);
    expect(paperInput.text).toContain("PAPER_DISCOURSE_RULES");
    expect(paperInput.text).toContain("paper_subtype: survey");
    expect(paperInput.text).toContain("method_description");

    const technicalArtifact = buildProfileSidecarArtifact(w, byLid, md, {}, technical);
    const paperArtifact = buildProfileSidecarArtifact(w, byLid, md, {}, paper);
    expect(technicalArtifact.content_hash).not.toBe(paperArtifact.content_hash);
    expect(computeProfileSidecarStatus([w], byLid, md, new Map([[w.id, technicalArtifact]]), paper).pending).toEqual([w.id]);
    expect(computeProfileSidecarStatus([w], byLid, md, new Map([[w.id, paperArtifact]]), paper).done).toEqual([w.id]);
  });

  it("computes done/pending using existence plus content_hash", () => {
    const existing = new Map<number, Pass1ArtifactMeta>();
    const doneWindow = windows[0];
    existing.set(doneWindow.id, {
      content_hash: pass1ContentHash(buildPass1Input(doneWindow, byLid, md)),
    });
    if (windows[1]) existing.set(windows[1].id, { content_hash: "stale" });

    const status = computeProfileSidecarStatus(windows, byLid, md, existing);
    expect(status.done).toEqual([doneWindow.id]);
    expect(status.pending).toEqual(windows.slice(1).map((w) => w.id));
  });
});
