import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXTRACTOR_CONTRACT_SCHEMA_VERSIONS,
  ExtractorContractError,
  PROFILE_SIDECAR_FIELD_CONTRACTS_V1,
  automaticBuildFailureDiagnosticFromError,
  parseExtractorCandidate,
  parseExtractorContractErrorFromStderr,
  renderExtractorContractMarkdown,
  type ExtractorFieldContractV1,
} from "../src/extractor-contract";
import {
  AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1,
  PROFILE_SIDECAR_POLICY_V2,
} from "../src/automatic-build-protocol";
import {
  automaticBuildExtractionPolicy,
  extractionPolicyDigest,
} from "../src/semantic-artifact";
import { resolveContentProfile } from "../src/content-profile";
import {
  EXTRACTOR_CONTRACT_BEGIN_MARKER,
  EXTRACTOR_CONTRACT_END_MARKER,
  replaceGeneratedExtractorContractBlock,
  syncExtractorContracts,
} from "../../../scripts/sync-extractor-contracts";

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
  it("projects extractor errors into stable bounded failure diagnostics", () => {
    const privateCandidate = `PRIVATE_FAILURE_CANDIDATE_${"S".repeat(201)}`;
    let failure: unknown;
    try {
      parseExtractorCandidate("profile_sidecar", {
        discourse_items: [{
          lid: "3.1",
          mode: "informative",
          local_summary: privateCandidate,
          relations: [],
        }],
      }, { allowed_evidence_lids: ["3.1"], formula_lids: [] });
    } catch (error) {
      failure = error;
    }

    const diagnostic = automaticBuildFailureDiagnosticFromError(failure);
    expect(diagnostic).toMatchObject({
      version: "automatic_build_failure_diagnostic.v2",
      category: "schema",
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_summary",
    });
    expect(diagnostic.diagnostic_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(diagnostic)).not.toContain(privateCandidate);

    const sameCause = new ExtractorContractError(diagnosticOf(() => parseExtractorCandidate("profile_sidecar", {
      discourse_items: [{
        lid: "3.1",
        mode: "informative",
        local_summary: "X".repeat(201),
        relations: [],
      }],
    }, { allowed_evidence_lids: ["3.1"], formula_lids: [] })));
    expect(automaticBuildFailureDiagnosticFromError(sameCause).diagnostic_digest)
      .toBe(diagnostic.diagnostic_digest);

    const evidenceFailure = new ExtractorContractError(diagnosticOf(() => parseExtractorCandidate(
      "profile_sidecar",
      {
        discourse_items: [{
          lid: "3.1",
          mode: "informative",
          relations: [{
            target_lid: "3.2",
            type: "explains",
            direction: "forward",
            confidence: 0.9,
            evidence_lids: ["3.1", "9.9"],
          }],
        }],
      },
      { allowed_evidence_lids: ["3.1", "3.2"], formula_lids: [] },
    )));
    expect(automaticBuildFailureDiagnosticFromError(evidenceFailure)).toMatchObject({
      category: "evidence",
      code: "evidence_out_of_scope",
    });

    const transported = parseExtractorContractErrorFromStderr(
      `prefix\nExtractorContractError: ${JSON.stringify((failure as ExtractorContractError).diagnostic)}\n    at private-path`,
    );
    expect(transported).toBeInstanceOf(ExtractorContractError);
    expect(automaticBuildFailureDiagnosticFromError(transported)).toEqual(diagnostic);
  });

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

  it("renders the profile-sidecar local summary limit into the generated model contract", () => {
    const contract = renderExtractorContractMarkdown("profile_sidecar");

    expect(contract).toContain("local_summary.max_length=200");
  });

  it("keeps paper profile hints in their schema-owned profile-sidecar fields", () => {
    const contract = renderExtractorContractMarkdown("profile_sidecar");
    const localFunctionStart = contract.indexOf("local_function.profile_hints.paper");
    const rhetoricalMoveStart = contract.indexOf("rhetorical_move.profile_hints.paper");

    expect(localFunctionStart).toBeGreaterThanOrEqual(0);
    expect(rhetoricalMoveStart).toBeGreaterThan(localFunctionStart);

    const localFunctionHints = contract.slice(localFunctionStart, rhetoricalMoveStart);
    expect(localFunctionHints).toContain("research_question");
    expect(localFunctionHints).toContain("related_work");
    expect(localFunctionHints).not.toContain("problem_framing");
    expect(localFunctionHints).not.toContain("related_work_positioning");

    const rhetoricalMoveHints = contract.slice(rhetoricalMoveStart);
    expect(rhetoricalMoveHints).toContain("problem_framing");
    expect(rhetoricalMoveHints).toContain("related_work_positioning");
  });

  it("uses one field contract for the profile-sidecar schema and generated constraints", () => {
    const fieldContracts: readonly ExtractorFieldContractV1[] = PROFILE_SIDECAR_FIELD_CONTRACTS_V1;
    const localSummary = fieldContracts
      .find((contract) => contract.field === "local_summary");
    expect(localSummary).toMatchObject({ required: false, nullable: false, min_length: 1, max_length: 200 });
    const paperHints = Object.fromEntries(fieldContracts
      .filter((contract) => contract.profile_hints?.paper)
      .map((contract) => [contract.field, contract.profile_hints?.paper]));
    expect(paperHints.local_function).not.toContain("problem_framing");
    expect(paperHints.rhetorical_move).toContain("problem_framing");
    expect(renderExtractorContractMarkdown("profile_sidecar"))
      .toContain(`local_summary.max_length=${localSummary?.max_length}`);
  });

  it("keeps marker synchronization read-only in check mode and fails closed on malformed markers", () => {
    const prompt = readFileSync(path.join(REPO_ROOT, "agents", "profile-sidecar-extractor.md"), "utf8");
    const generated = renderExtractorContractMarkdown("profile_sidecar");
    expect(replaceGeneratedExtractorContractBlock(prompt, generated)).toBe(prompt);
    expect(syncExtractorContracts("check", REPO_ROOT)).toEqual({ checked: 3, changed: [] });
    expect(() => replaceGeneratedExtractorContractBlock(
      prompt.replace(EXTRACTOR_CONTRACT_BEGIN_MARKER, ""),
      generated,
    )).toThrow(/exactly one generated contract marker pair/);
    expect(() => replaceGeneratedExtractorContractBlock(
      `${prompt}\n${EXTRACTOR_CONTRACT_END_MARKER}`,
      generated,
    )).toThrow(/exactly one generated contract marker pair/);
  });

  it("keeps closed enums, numeric bounds, and paper hint members out of handwritten prompt text", () => {
    const prompt = readFileSync(path.join(REPO_ROOT, "agents", "profile-sidecar-extractor.md"), "utf8");
    const start = prompt.indexOf(EXTRACTOR_CONTRACT_BEGIN_MARKER);
    const end = prompt.indexOf(EXTRACTOR_CONTRACT_END_MARKER);
    const handwritten = `${prompt.slice(0, start)}${prompt.slice(end + EXTRACTOR_CONTRACT_END_MARKER.length)}`;
    for (const duplicate of [
      "Closed enums:",
      "Closed relation enums:",
      "informative | argumentative",
      "local_summary.max_length=200",
      "problem_framing",
      "related_work_positioning",
    ]) {
      expect(handwritten, duplicate).not.toContain(duplicate);
    }
  });

  it("publishes profile_sidecar_policy.v2 under one raw prompt hash", () => {
    const prompt = readFileSync(path.join(REPO_ROOT, "agents", "profile-sidecar-extractor.md"), "utf8");
    const promptSha256 = createHash("sha256").update(prompt).digest("hex");
    const policy = automaticBuildExtractionPolicy(
      "profile_sidecar",
      resolveContentProfile("technical_learning"),
      "full",
    );
    expect(policy).toMatchObject(PROFILE_SIDECAR_POLICY_V2);
    expect(promptSha256).toBe(PROFILE_SIDECAR_POLICY_V2.prompt_sha256);
    const releaseMembers = AUTOMATIC_BUILD_RELEASE_POLICY_MEMBERS_V1
      .filter((member) => member.prompt_name === "profile-sidecar-extractor.md");
    expect(releaseMembers).toHaveLength(2);
    expect(releaseMembers.every((member) => (
      member.stage_policy_version === PROFILE_SIDECAR_POLICY_V2.stage_policy_version
      && member.prompt_sha256 === promptSha256
      && member.schema_version === EXTRACTOR_CONTRACT_SCHEMA_VERSIONS.profile_sidecar
    ))).toBe(true);
    expect(extractionPolicyDigest(policy)).not.toBe(extractionPolicyDigest({
      ...policy,
      stage_policy_version: "profile_sidecar_policy.v1",
      prompt_sha256: "0a56b04e68fc4fc86ae292eb0a57f59d2c85bd9b27e61e7da2d3b5c503da297a",
    }));
  });

  it("rejects the two profile-sidecar drift candidates with bounded schema diagnostics", () => {
    const overlongSummary = "S".repeat(201);
    const summaryDiagnostic = diagnosticOf(() => parseExtractorCandidate("profile_sidecar", {
      discourse_items: [{
        lid: "3.1",
        mode: "informative",
        local_summary: overlongSummary,
        relations: [],
      }],
    }, { allowed_evidence_lids: ["3.1"], formula_lids: [] }));
    expect(summaryDiagnostic).toMatchObject({
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_summary",
    });
    expect(JSON.stringify(summaryDiagnostic)).not.toContain(overlongSummary);

    const enumDiagnostic = diagnosticOf(() => parseExtractorCandidate("profile_sidecar", {
      discourse_items: [{
        lid: "3.1",
        mode: "informative",
        local_function: "problem_framing",
        local_summary: "PRIVATE_CANDIDATE_MUST_NOT_ESCAPE",
        relations: [],
      }],
    }, { allowed_evidence_lids: ["3.1"], formula_lids: [] }));
    expect(enumDiagnostic).toMatchObject({
      code: "schema_invalid",
      json_pointer: "/discourse_items/0/local_function",
      actual: "problem_framing",
    });
    expect(JSON.stringify(enumDiagnostic)).not.toContain("PRIVATE_CANDIDATE_MUST_NOT_ESCAPE");
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
