import { describe, expect, it } from "vitest";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { splitWindows, type WindowBudget } from "../src/window";
import { buildPass1Input } from "../src/pass1-input";
import { buildProfiledPass1Input } from "../src/pass1-profile-input";
import { resolveContentProfile } from "../src/content-profile";
import { buildPass1Artifact, computeBuildStatus } from "../src/build-resume";
import type { Pass1Output } from "../src/merge";

const md = "# Paper\n\nWe define RAG as retrieval augmented generation.\n\nThe method improves recall.";
const nodes = segment(markdownToBlocks(md));
const byLid = new Map(nodes.map((node) => [node.lid, node]));
const BIG: WindowBudget = { maxInputTokens: 1_000_000, maxLeavesSoft: 10_000 };
const [window0] = splitWindows(nodes, md, BIG);

describe("PP4 profiled Pass1 input", () => {
  it("keeps technical_learning Pass1 input byte-for-byte unchanged", () => {
    const profile = resolveContentProfile("technical_learning");
    expect(buildProfiledPass1Input(window0, byLid, md, profile)).toEqual(buildPass1Input(window0, byLid, md));
  });

  it("adds paper rule-pack instructions while preserving LID-marked source text", () => {
    const profile = resolveContentProfile("paper", { paper_subtype: "survey" });
    const profiled = buildProfiledPass1Input(window0, byLid, md, profile);

    expect(profiled.text).toContain("PAPER_PASS1_RULES");
    expect(profiled.text).toContain("paper_subtype: survey");
    expect(profiled.text).toContain("graph_shape: use only existing GraphNode types entity | concept | claim");
    expect(profiled.text).toContain("field_scope, taxonomy_axes, literature_clusters");
    expect(profiled.text).toContain("citation_anchor: LID only");
    expect(profiled.text).toContain("TEXT");
    for (const lid of window0.leafLids) {
      expect(profiled.text).toContain(`[${lid}]`);
    }
  });

  it("binds Pass1 resume content_hash to the content profile", () => {
    const output: Pass1Output = { nodes: [], edges: [] };
    const technical = resolveContentProfile("technical_learning");
    const paper = resolveContentProfile("paper");
    const technicalArtifact = buildPass1Artifact(window0, byLid, md, output, technical);
    const paperArtifact = buildPass1Artifact(window0, byLid, md, output, paper);

    expect(technicalArtifact.content_hash).not.toBe(paperArtifact.content_hash);
    expect(computeBuildStatus([window0], byLid, md, new Map([[window0.id, technicalArtifact]]), paper).pending).toEqual([
      window0.id,
    ]);
    expect(computeBuildStatus([window0], byLid, md, new Map([[window0.id, paperArtifact]]), paper).done).toEqual([window0.id]);
  });
});
