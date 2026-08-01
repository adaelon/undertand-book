import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_CONTRACT_SCHEMA_VERSIONS,
  ExtractorContractError,
  parseExtractorCandidate,
  renderExtractorContractMarkdown,
} from "../src/extractor-contract";
import { automaticBuildExtractionPolicy } from "../src/semantic-artifact";
import { resolveContentProfile } from "../src/content-profile";

const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

function diagnosticOf(run: () => unknown) {
  try {
    run();
    throw new Error("expected extractor contract failure");
  } catch (error) {
    if (!(error instanceof ExtractorContractError)) throw error;
    return error.diagnostic;
  }
}

describe("automatic build extractor contracts", () => {
  it("binds every semantic policy hash to the raw extractor prompt bytes", () => {
    const fixtures = [
      ["pass1", "pass1-local-extractor.md", "technical_learning"],
      ["paper_metadata", "paper-metadata-extractor.md", "paper"],
      ["paper_lexicon", "paper-lexicon-extractor.md", "paper"],
      ["profile_sidecar", "profile-sidecar-extractor.md", "technical_learning"],
      ["pass2", "pass2-longrange-linker.md", "technical_learning"],
      ["book_structure", "book-structure-extractor.md", "technical_learning"],
    ] as const;
    for (const [stage, promptName, profileId] of fixtures) {
      const prompt = readFileSync(path.join(REPO_ROOT, "agents", promptName), "utf8");
      const policy = automaticBuildExtractionPolicy(stage, resolveContentProfile(profileId), "full");
      expect(policy.prompt_sha256, promptName)
        .toBe(createHash("sha256").update(prompt).digest("hex"));
    }
  });

  it("rejects task-22 metadata reference strings with a stable bounded diagnostic", () => {
    const diagnostic = diagnosticOf(() => parseExtractorCandidate("paper_metadata", {
      paper_metadata: {
        references: {
          value: ["Smith 2020"],
          source: "paper_text",
          evidence_lids: ["1.1"],
        },
      },
    }, { allowed_evidence_lids: ["1.1"] }));
    expect(diagnostic).toEqual({
      version: "automatic_build_extractor_diagnostic.v1",
      code: "schema_invalid",
      json_pointer: "/paper_metadata/references/value/0",
      expected: "object",
      actual: "Smith 2020",
    });

    expect(parseExtractorCandidate("paper_metadata", {
      paper_metadata: {
        references: {
          value: [{ raw: "Smith 2020", identifiers: { doi: "10.1/example" } }],
          source: "paper_text",
          evidence_lids: ["1.1"],
        },
      },
    }, { allowed_evidence_lids: ["1.1"] })).toMatchObject({
      paper_metadata: { references: { value: [{ raw: "Smith 2020" }] } },
    });
  });

  it("rejects task-23 lexicon definition anchors outside occurrences before the semantic gate", () => {
    const diagnostic = diagnosticOf(() => parseExtractorCandidate("paper_lexicon", {
      entries: [{
        term: "RAG",
        term_type: "acronym",
        occurrences_lids: ["1.2"],
        defined_at_lid: "1.1",
      }],
    }, { allowed_evidence_lids: ["1.1", "1.2"] }));
    expect(diagnostic).toEqual({
      version: "automatic_build_extractor_diagnostic.v1",
      code: "defined_at_not_occurrence",
      json_pointer: "/entries/0/defined_at_lid",
      expected: "one of /entries/0/occurrences_lids",
      actual: "1.1",
      evidence_violation: {
        kind: "cross_field",
        offending_lids: ["1.1"],
        allowed_lids: ["1.2"],
      },
    });
    expect(parseExtractorCandidate("paper_lexicon", {
      entries: [{ term: "RAG", term_type: "acronym", occurrences_lids: ["1.1"], defined_at_lid: "1.1" }],
    }, { allowed_evidence_lids: ["1.1"] })).toMatchObject({ entries: [{ term: "RAG" }] });
  });

  it("reports profile-sidecar evidence violations without returning the candidate payload", () => {
    const diagnostic = diagnosticOf(() => parseExtractorCandidate("profile_sidecar", {
      discourse_items: [{
        lid: "3.1",
        mode: "informative",
        local_summary: "MUST_NOT_APPEAR_IN_DIAGNOSTIC",
        relations: [{
          target_lid: "3.2",
          type: "explains",
          direction: "forward",
          confidence: 0.9,
          evidence_lids: ["3.1", "9.9"],
        }],
      }],
      formula_semantics: [],
    }, { allowed_evidence_lids: ["3.1", "3.2"], formula_lids: [] }));
    expect(diagnostic).toMatchObject({
      code: "evidence_out_of_scope",
      json_pointer: "/discourse_items/0/relations/0/evidence_lids",
      evidence_violation: { offending_lids: ["9.9"], allowed_lids: ["3.1", "3.2"] },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("MUST_NOT_APPEAR_IN_DIAGNOSTIC");
    expect(parseExtractorCandidate("profile_sidecar", {
      discourse_items: [{
        lid: "3.1",
        mode: "informative",
        relations: [{
          target_lid: "3.2",
          type: "explains",
          direction: "forward",
          confidence: 0.9,
          evidence_lids: ["3.1", "3.2"],
        }],
      }],
      formula_semantics: [],
    }, { allowed_evidence_lids: ["3.1", "3.2"], formula_lids: [] })).toMatchObject({
      discourse_items: [{ lid: "3.1" }],
    });
  });

  it("keeps prompt contract blocks and AP7 policy fingerprints on the same schema source", () => {
    const fixtures = [
      ["paper_metadata", "paper-metadata-extractor.md"],
      ["paper_lexicon", "paper-lexicon-extractor.md"],
      ["profile_sidecar", "profile-sidecar-extractor.md"],
    ] as const;
    for (const [stage, promptName] of fixtures) {
      const prompt = readFileSync(path.join(REPO_ROOT, "agents", promptName), "utf8");
      const start = prompt.indexOf("<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->");
      const endMarker = "<!-- END GENERATED EXTRACTOR CONTRACT -->";
      const end = prompt.indexOf(endMarker);
      expect(start, promptName).toBeGreaterThanOrEqual(0);
      expect(end, promptName).toBeGreaterThan(start);
      const block = prompt.slice(start, end + endMarker.length);
      expect(block.trim(), promptName).toBe(renderExtractorContractMarkdown(stage).trim());
      expect(block, promptName).toContain(EXTRACTOR_CONTRACT_SCHEMA_VERSIONS[stage]);

      const policy = automaticBuildExtractionPolicy(stage, resolveContentProfile(stage === "profile_sidecar" ? "technical_learning" : "paper"), "full");
      expect(policy.schema_version).toBe(EXTRACTOR_CONTRACT_SCHEMA_VERSIONS[stage]);
      expect(policy.prompt_sha256).toBe(createHash("sha256").update(prompt).digest("hex"));
    }
  });
});
