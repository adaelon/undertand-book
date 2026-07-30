import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getArtifactBlueprintRegistryEntryV1,
  listArtifactBlueprintRegistryV1,
  recordArtifactBlueprintUseV1,
  resolveArtifactBlueprintV1,
  retireArtifactBlueprintCandidateV1,
  upsertArtifactBlueprintCandidateV1,
} from "../src/artifact-blueprint-registry";
import type { ArtifactBlueprintV1 } from "../src/artifact-blueprint";
import { runIntentBlueprintRegistryCommand } from "../../../skills/build/intent-blueprint";

const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function privateRoot(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `understand-book-${label}-`));
  roots.push(root);
  return root;
}

function candidate(overrides: Partial<ArtifactBlueprintV1> = {}): ArtifactBlueprintV1 {
  return {
    version: "artifact_blueprint.v1",
    blueprint_id: "user.implementation_checklist",
    blueprint_version: "1.0.0",
    origin: "user_private",
    title: "Implementation checklist",
    purpose: "Track bounded implementation actions.",
    shape: "collection",
    record_schema: {
      type: "object",
      properties: {
        action: { type: "string", max_length: 200 },
        done: { type: "boolean" },
      },
      required: ["action", "done"],
      additional_properties: false,
      max_properties: 2,
    },
    routing: {
      use_when: ["The user asks what remains to implement."],
      avoid_when: ["The user asks for verbatim source evidence."],
      covered_topics: ["implementation"],
      scope_label: "confirmed source scope",
    },
    search_fields: [{ path: "/action", weight: 10, analyzer: "text" }],
    summary_fields: ["/action", "/done"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 100, max_relations: 0, max_text_chars: 20_000 },
    ...overrides,
  };
}

describe("user-private ArtifactBlueprint registry", () => {
  it("keeps candidate versions create-only while retire and usage remain append-only metadata", () => {
    const root = privateRoot("blueprint-registry");
    const blueprint = candidate();
    const created = upsertArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint,
      created_at: "2026-07-29T10:00:00.000Z",
    });
    expect(created.disposition).toBe("created");
    expect(upsertArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint,
      created_at: "2026-07-29T10:01:00.000Z",
    })).toMatchObject({ disposition: "existing", digest: created.digest });

    expect(() => upsertArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint: candidate({ title: "Conflicting title" }),
      created_at: "2026-07-29T10:02:00.000Z",
    })).toThrow(/same identity and version|conflict/i);

    expect(recordArtifactBlueprintUseV1({
      private_root: root,
      blueprint_id: blueprint.blueprint_id,
      blueprint_version: blueprint.blueprint_version,
      usage_id: "plan-1",
      used_at: "2026-07-29T10:03:00.000Z",
    })).toMatchObject({ disposition: "created", usage_count: 1 });
    expect(recordArtifactBlueprintUseV1({
      private_root: root,
      blueprint_id: blueprint.blueprint_id,
      blueprint_version: blueprint.blueprint_version,
      usage_id: "plan-1",
      used_at: "2026-07-29T10:03:00.000Z",
    })).toMatchObject({ disposition: "existing", usage_count: 1 });

    const frozenPlanSnapshot = getArtifactBlueprintRegistryEntryV1(
      root,
      blueprint.blueprint_id,
      blueprint.blueprint_version,
    );
    expect(retireArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint_id: blueprint.blueprint_id,
      blueprint_version: blueprint.blueprint_version,
      retired_at: "2026-07-29T10:04:00.000Z",
    })).toMatchObject({ disposition: "created", status: "retired" });
    const retired = getArtifactBlueprintRegistryEntryV1(
      root,
      blueprint.blueprint_id,
      blueprint.blueprint_version,
    );
    expect(retired).toMatchObject({ status: "retired", usage_count: 1 });
    expect(retired.blueprint).toEqual(frozenPlanSnapshot.blueprint);
    expect(retired.digest).toBe(frozenPlanSnapshot.digest);
  });

  it("lists system presets first and resolves an unpersisted one-off when the private registry is empty", () => {
    const root = privateRoot("blueprint-resolution");
    const listed = listArtifactBlueprintRegistryV1(root);
    expect(listed.system_presets.map((entry) => entry.blueprint.blueprint_id)).toEqual([
      "system.argument_map",
      "system.comparison_table",
      "system.concept_map",
      "system.timeline",
    ]);
    expect(listed.user_candidates).toEqual([]);

    const oneOff = candidate({
      blueprint_id: "one-off.study_questions",
      origin: "one_off",
      title: "Study questions",
    });
    expect(resolveArtifactBlueprintV1({
      private_root: root,
      blueprint_id: oneOff.blueprint_id,
      blueprint_version: oneOff.blueprint_version,
      one_off: oneOff,
      planning_candidate: true,
    })).toMatchObject({ source: "one_off", blueprint: oneOff });

    const legacyFreeFormKeyword = candidate({
      blueprint_id: "one-off.legacy_exact_actions",
      origin: "one_off",
      search_fields: [{ path: "/action", weight: 10, analyzer: "keyword" }],
    });
    expect(resolveArtifactBlueprintV1({
      private_root: root,
      blueprint_id: legacyFreeFormKeyword.blueprint_id,
      blueprint_version: legacyFreeFormKeyword.blueprint_version,
      one_off: legacyFreeFormKeyword,
    })).toMatchObject({ source: "one_off", blueprint: legacyFreeFormKeyword });
    expect(() => runIntentBlueprintRegistryCommand({
      version: "artifact_blueprint_registry_command.v1",
      operation: "resolve",
      input: {
        private_root: root,
        blueprint_id: legacyFreeFormKeyword.blueprint_id,
        blueprint_version: legacyFreeFormKeyword.blueprint_version,
        one_off: legacyFreeFormKeyword,
        planning_candidate: true,
      },
    })).toThrow(/free-form string.*text/i);

    const maliciousFallback = candidate({
      blueprint_id: "system.timeline",
      blueprint_version: "1.0.0",
      origin: "one_off",
      title: "Shadow timeline",
    });
    expect(resolveArtifactBlueprintV1({
      private_root: root,
      blueprint_id: "system.timeline",
      blueprint_version: "1.0.0",
      one_off: maliciousFallback,
    })).toMatchObject({ source: "system", blueprint: { title: "Timeline" } });
  });

  it("fails closed on traversal, symlinked storage, extra private payloads, and command-shape drift", () => {
    const root = privateRoot("blueprint-redaction");
    expect(() => upsertArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint: candidate({ blueprint_id: "../escape" }),
      created_at: "2026-07-29T10:00:00.000Z",
    })).toThrow(/path-safe/i);
    expect(() => upsertArtifactBlueprintCandidateV1({
      private_root: root,
      blueprint: { ...candidate(), raw_goal: "PRIVATE_GOAL_SENTINEL" } as unknown as ArtifactBlueprintV1,
      created_at: "2026-07-29T10:00:00.000Z",
    })).toThrow(/unknown field/i);
    expect(() => runIntentBlueprintRegistryCommand({
      version: "artifact_blueprint_registry_command.v1",
      operation: "list",
      input: { private_root: root, raw_goal: "PRIVATE_GOAL_SENTINEL" },
    })).toThrow(/unrecognized or missing keys/i);

    const outside = privateRoot("blueprint-outside");
    const registryPath = path.join(root, "artifact-blueprint-registry");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, registryPath, process.platform === "win32" ? "junction" : "dir");
    expect(() => listArtifactBlueprintRegistryV1(root)).toThrow(/symlink/i);
    expect(readFileSync(path.resolve(process.cwd(), "../../skills/build/sidecar-entry.ts"), "utf8"))
      .toContain('command === "intent.blueprint"');
  });
});
