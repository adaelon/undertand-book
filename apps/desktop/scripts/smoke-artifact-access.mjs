import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "tsx/esm";

const [buildIntentV1, buildIntentV2, artifactBlueprint, intentArtifact] = await Promise.all([
  import("../../../packages/core/src/build-intent.ts"),
  import("../../../packages/core/src/build-intent-v2.ts"),
  import("../../../packages/core/src/artifact-blueprint.ts"),
  import("../../../packages/core/src/intent-artifact.ts"),
]);
const {
  attachBuildPlanDigest,
  canonicalBuildJson,
  computeBuildIntentDigest,
  validateBuildIntentV1,
} = buildIntentV1;
const {
  attachBuildPlanDigestV2,
  computeBuildIntentDigestV2,
  validateBuildIntentV2,
} = buildIntentV2;
const {
  computeArtifactBlueprintDigest,
  getSystemArtifactBlueprintV1,
  validateArtifactBlueprintV1,
} = artifactBlueprint;
const {
  acceptIntentArtifactCandidate,
  compileIntentArtifactTasks,
} = intentArtifact;

if (process.platform !== "win32") {
  throw new Error("AA11 packaged artifact-access smoke currently supports Windows only");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..", "..");
const smokeRoot = mkdtempSync(path.join(tmpdir(), "understand-book-aa11-artifact-access-"));
const privateRoot = path.join(smokeRoot, "private");
const booksRoot = path.join(smokeRoot, "books");
const localAppData = path.join(smokeRoot, "local-app-data");
const registryRoot = path.join(smokeRoot, "registry");
const outputPath = parseOutputPath(process.argv.slice(2));

const packagedSidecar = process.env.UNDERSTAND_BOOK_BUILD_EXE
  ?? path.join(desktopRoot, "src-tauri", "binaries", "understand-book-build-x86_64-pc-windows-msvc.exe");
const packagedMcp = process.env.UNDERSTAND_BOOK_MCP_BIN
  ?? path.join(desktopRoot, "src-tauri", "binaries", "book-mcp-x86_64-pc-windows-msvc.exe");
const residentServer = process.env.UNDERSTAND_BOOK_SERVER_BIN
  ?? path.join(repoRoot, "target", "debug", "server.exe");
const installedDesktop = process.env.UNDERSTAND_BOOK_DESKTOP_EXE
  ?? resolveInstalledDesktop();

const bookInputs = [
  {
    profile: "technical_learning",
    sourceDir: process.env.AA11_TECHNICAL_BOOK_DIR
      ?? path.join(repoRoot, ".understand-book", "quantification-essence"),
  },
  {
    profile: "paper",
    sourceDir: process.env.AA11_PAPER_BOOK_DIR
      ?? path.join(repoRoot, ".understand-book", "understanding-transformer-from-the-perspective-of-reviewed-v2"),
  },
];

for (const [label, file] of [
  ["packaged build sidecar", packagedSidecar],
  ["packaged Book MCP", packagedMcp],
  ["installed Desktop controller", installedDesktop],
  ["current Resident Server", residentServer],
]) {
  assert(file && existsSync(file), `${label} is missing: ${file ?? "<unresolved>"}`);
}

mkdirSync(privateRoot, { recursive: true });
mkdirSync(booksRoot, { recursive: true });
mkdirSync(registryRoot, { recursive: true });
mkdirSync(path.join(localAppData, "UnderstandBook"), { recursive: true });
writeJson(path.join(localAppData, "UnderstandBook", "settings.json"), {
  schema: "understand_book.desktop_settings.v1",
  library_root: booksRoot,
});

async function runAudit() {
  try {
    const books = bookInputs.map(prepareRealBook);
    const auditBooks = [];
    for (const book of books) auditBooks.push(await auditBook(book));

    const audit = {
      version: "aa11_artifact_access_audit.v1",
      generated_at: new Date().toISOString(),
      inputs: {
        book_count: auditBooks.length,
        profiles: auditBooks.map((book) => book.profile),
        packaged_desktop: true,
        packaged_sidecar: true,
        packaged_plugin_mcp: true,
        isolated_private_root: true,
        copied_real_book_bases: true,
      },
      books: auditBooks,
      release_gate: {
        status: "pass",
        preset_reuse: auditBooks.every((book) => book.blueprints.preset_reuse),
        one_off_blueprint: auditBooks.every((book) => book.blueprints.one_off),
        legacy_v1_adapter: auditBooks.every((book) => book.blueprints.v1_adapter),
        three_consumer_surfaces_consistent: auditBooks.every((book) => book.consumers.consistent),
        replan_source_stale_delete_no_overlay: auditBooks.every((book) => book.fail_closed.all_passed),
        related_search_at_most_once: auditBooks.every((book) => book.resident.related.artifact_search_calls <= 1),
        unrelated_artifact_calls_zero: auditBooks.every((book) => book.resident.unrelated.artifact_calls === 0),
        user_disabled_artifact_calls_zero: auditBooks.every((book) => book.resident.user_disabled.artifact_calls === 0),
        canonical_book_evidence_refetched: auditBooks.every((book) => (
          book.resident.related.book_text_calls === 1 && book.resident.related.source_present_calls === 1
        )),
        private_goal_leaks: 0,
      },
    };

    if (outputPath) {
      mkdirSync(path.dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(audit, null, 2)}\n`);
  } finally {
    assertTemporaryRoot(smokeRoot);
    rmSync(smokeRoot, { recursive: true, force: true });
  }
}

function parseOutputPath(args) {
  if (args.length === 0) return null;
  assert.equal(args.length, 2, "usage: node smoke-artifact-access.mjs [--output <audit.json>]");
  assert.equal(args[0], "--output", "only --output is supported");
  return path.resolve(args[1]);
}

function resolveInstalledDesktop() {
  const result = spawnSync("reg.exe", ["query", "HKCU\\Software\\UnderstandBook", "/v", "InstallDir"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  const match = result.stdout.match(/InstallDir\s+REG_SZ\s+(.+)$/mu);
  return match ? path.join(match[1].trim(), "UnderstandBook.exe") : null;
}

function assertTemporaryRoot(root) {
  const resolved = path.resolve(root);
  const expectedParent = `${path.resolve(tmpdir())}${path.sep}`.toLowerCase();
  assert(resolved.toLowerCase().startsWith(expectedParent), "AA11 cleanup escaped the OS temporary directory");
  assert(path.basename(resolved).startsWith("understand-book-aa11-artifact-access-"), "AA11 cleanup root has an unexpected name");
}

function writeJson(target, value) {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stablePayloadDigest(value) {
  return sha256(Buffer.from(canonicalBuildJson(value), "utf8"));
}

function prepareRealBook(input) {
  const sourceDir = path.resolve(input.sourceDir);
  assert(existsSync(path.join(sourceDir, "base.json")), `real ${input.profile} book base.json is missing`);
  assert(existsSync(path.join(sourceDir, "source.txt")), `real ${input.profile} book source.txt is missing`);
  const base = JSON.parse(readFileSync(path.join(sourceDir, "base.json"), "utf8"));
  assert(Array.isArray(base.lid_nodes) && base.lid_nodes.length >= 500, `${input.profile} input is not a real-book base`);
  assert.match(base.book_id, /^[A-Za-z0-9_-]+$/u, "real-book id must be path-safe");
  assertRealBookProfile(sourceDir, input.profile);

  const cloneDir = path.join(booksRoot, base.book_id);
  mkdirSync(cloneDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (entry.name === "source.txt" || entry.name === "base.json" || entry.name.endsWith(".json")) {
      copyFileSync(path.join(sourceDir, entry.name), path.join(cloneDir, entry.name));
    }
  }

  const sourceBytes = readFileSync(path.join(cloneDir, "source.txt"));
  const source = sourceBytes.toString("utf8");
  const node = base.lid_nodes.find((candidate) => (
    candidate.kind === "paragraph"
    && Number.isInteger(candidate.span?.start)
    && Number.isInteger(candidate.span?.end)
    && candidate.span.end - candidate.span.start >= 40
  ));
  assert(node, `${input.profile} real book has no substantive paragraph LID`);
  const excerpt = source.slice(node.span.start, node.span.end).replace(/\s+/gu, " ").trim().slice(0, 360);
  assert(excerpt.length >= 20, `${input.profile} real-book paragraph excerpt is unexpectedly empty`);
  const searchTerm = deriveSearchTerm(excerpt);
  assert(searchTerm.length >= 2, `${input.profile} real-book paragraph has no stable lexical query`);

  return {
    profile: input.profile,
    profileSpec: input.profile === "paper"
      ? { id: "paper", version: "paper_v0" }
      : { id: "technical_learning", version: "technical_learning_v0" },
    bookId: base.book_id,
    cloneDir,
    sourceBytes,
    sourceFingerprint: sha256(sourceBytes),
    availableLids: base.lid_nodes.map((candidate) => candidate.lid),
    lid: node.lid,
    excerpt,
    searchTerm,
    bodySentinel: `AA11_RECORD_BODY_${input.profile.toUpperCase()}`,
    goalSentinel: `AA11_PRIVATE_GOAL_${input.profile.toUpperCase()}`,
    lidCount: base.lid_nodes.length,
  };
}

function assertRealBookProfile(sourceDir, profile) {
  if (profile === "technical_learning") {
    const metadata = JSON.parse(readFileSync(path.join(sourceDir, "profile_metadata.json"), "utf8"));
    assert.equal(metadata.header?.profile_id, profile, "technical real book profile mismatch");
    return;
  }
  const manifest = JSON.parse(readFileSync(path.join(sourceDir, ".build", "input", "manifest.json"), "utf8"));
  assert.equal(manifest.profile_id, profile, "paper real book profile mismatch");
}

function deriveSearchTerm(excerpt) {
  const cjk = excerpt.match(/[\p{Script=Han}]{3,8}/u)?.[0];
  if (cjk) return cjk;
  const word = excerpt.match(/[A-Za-z][A-Za-z0-9-]{5,}/u)?.[0];
  if (word) return word;
  return excerpt.slice(0, 16).trim();
}

function emptyEstimate(privateItem) {
  return {
    input_tokens: { lower: 0, upper: 0, coverage: 0 },
    output_tokens: { lower: 0, upper: 0, coverage: 0 },
    wall_clock_minutes: { confidence: "none" },
    unknown_stages: [privateItem],
    historical_match: { stage: false, policy: false, model: false, harness: false, sample_count: 0 },
  };
}

function createLegacySelection(book) {
  const intent = validateBuildIntentV1({
    version: "build_intent.v1",
    intent_id: `intent-aa11-v1-${book.profile}`,
    revision: 1,
    book_id: book.bookId,
    source_fingerprint: book.sourceFingerprint,
    content_profile: book.profileSpec,
    user_goal: `${book.goalSentinel} verify legacy adapter`,
    goal_kind: "analyze",
    source_scope: { whole_book: true, lids: [], sections: [] },
    desired_artifacts: ["comparison_table"],
    usage_horizon: "one_off",
    privacy: "reader_private",
    status: "confirmed",
    created_at: "2026-07-30T00:00:00.000Z",
    confirmed_at: "2026-07-30T00:00:01.000Z",
  });
  const intentDigest = computeBuildIntentDigest(intent);
  const artifactId = `artifact-aa11-v1-${book.profile}`;
  const plan = attachBuildPlanDigest({
    version: "build_plan.v1",
    plan_id: `plan-aa11-v1-${book.profile}`,
    revision: 1,
    book_id: book.bookId,
    source_fingerprint: book.sourceFingerprint,
    content_profile: book.profileSpec,
    recipe_id: "goal_directed",
    intent_id: intent.intent_id,
    intent_digest: intentDigest,
    public_stage_closure: [],
    private_artifacts: [{
      artifact_id: artifactId,
      artifact_type: "comparison_table",
      source_scope: intent.source_scope,
      required_public_capabilities: ["foundation.lid"],
      evidence_policy: "lid_required",
    }],
    reuse: [],
    create: [`private.${artifactId}`],
    excluded: [],
    estimate: emptyEstimate(`private.${artifactId}`),
    budget: { max_total_tokens: 10_000, on_exceed: "needs_user" },
    status: "confirmed",
    confirmation_source: "reader_ui",
    created_at: "2026-07-30T00:00:02.000Z",
    confirmed_at: "2026-07-30T00:00:03.000Z",
  });
  const payload = {
    rows: [{
      subject: book.excerpt,
      dimensions: { profile: book.profile, adapter: "accepted-v1-readonly" },
      evidence_lids: [book.lid],
    }],
  };
  const accepted = {
    version: "intent_artifact_accepted.v1",
    task_id: `intent-artifact-aa11-v1-${book.profile}`,
    book_id: book.bookId,
    source_fingerprint: book.sourceFingerprint,
    intent_id: intent.intent_id,
    intent_digest: intentDigest,
    plan_id: plan.plan_id,
    plan_digest: plan.plan_digest,
    artifact_id: artifactId,
    artifact_type: "comparison_table",
    payload,
    payload_digest: stablePayloadDigest(payload),
    accepted_at: "2026-07-30T00:00:04.000Z",
  };
  return { intent, intentDigest, plan, accepted, artifactId };
}

function createOneOffBlueprint(book) {
  return validateArtifactBlueprintV1({
    version: "artifact_blueprint.v1",
    blueprint_id: `one-off.aa11.${book.profile}`,
    blueprint_version: "1.0.0",
    origin: "one_off",
    title: `AA11 ${book.profile} evidence cards`,
    purpose: "Organize a bounded real-book passage for the AA11 access audit.",
    shape: "collection",
    record_schema: {
      type: "object",
      properties: {
        excerpt: { type: "string", min_length: 1, max_length: 600 },
        category: { type: "string", min_length: 1, max_length: 80 },
      },
      required: ["excerpt", "category"],
      additional_properties: false,
      max_properties: 2,
    },
    routing: {
      use_when: ["The question asks about the audited real-book passage."],
      avoid_when: ["The user requests source-only or verbatim evidence."],
      covered_topics: [book.profile, "AA11 access audit"],
      scope_label: "whole real book",
    },
    search_fields: [
      { path: "/excerpt", weight: 10, analyzer: "text" },
      { path: "/category", weight: 4, analyzer: "keyword" },
    ],
    summary_fields: ["/excerpt", "/category"],
    evidence_policy: { required_per_record: true, anchor: "lid" },
    limits: { max_records: 8, max_relations: 0, max_text_chars: 8_000 },
  });
}

function createV2Selection(book) {
  const intent = validateBuildIntentV2({
    version: "build_intent.v2",
    intent_id: `intent-aa11-v2-${book.profile}`,
    revision: 1,
    book_id: book.bookId,
    source_fingerprint: book.sourceFingerprint,
    content_profile: book.profileSpec,
    user_goal: `${book.goalSentinel} verify one-off and preset access`,
    goal_kind: "analyze",
    source_scope: { whole_book: true, lids: [], sections: [] },
    usage_horizon: "project",
    privacy: "reader_private",
    status: "confirmed",
    created_at: "2026-07-30T00:01:00.000Z",
    confirmed_at: "2026-07-30T00:01:01.000Z",
  });
  const intentDigest = computeBuildIntentDigestV2(intent);
  const oneOff = createOneOffBlueprint(book);
  const timeline = structuredClone(getSystemArtifactBlueprintV1("timeline").blueprint);
  const pending = structuredClone(getSystemArtifactBlueprintV1("concept_map").blueprint);
  const privateArtifacts = [
    {
      artifact_id: `artifact-aa11-one-off-${book.profile}`,
      source_scope: intent.source_scope,
      blueprint: oneOff,
      blueprint_digest: computeArtifactBlueprintDigest(oneOff),
      required_public_capabilities: ["foundation.lid"],
    },
    {
      artifact_id: `artifact-aa11-preset-${book.profile}`,
      source_scope: intent.source_scope,
      blueprint: timeline,
      blueprint_digest: computeArtifactBlueprintDigest(timeline),
      required_public_capabilities: ["foundation.lid"],
    },
    {
      artifact_id: `artifact-aa11-pending-${book.profile}`,
      source_scope: intent.source_scope,
      blueprint: pending,
      blueprint_digest: computeArtifactBlueprintDigest(pending),
      required_public_capabilities: ["foundation.lid"],
    },
  ];
  const plan = attachBuildPlanDigestV2({
    version: "build_plan.v2",
    plan_id: `plan-aa11-v2-${book.profile}`,
    revision: 1,
    book_id: book.bookId,
    source_fingerprint: book.sourceFingerprint,
    content_profile: book.profileSpec,
    recipe_id: "goal_directed",
    intent_id: intent.intent_id,
    intent_digest: intentDigest,
    public_stage_closure: [],
    private_artifacts: privateArtifacts,
    reuse: [],
    create: privateArtifacts.map((artifact) => `private.${artifact.artifact_id}`),
    excluded: [],
    estimate: emptyEstimate("private.aa11-artifact-set"),
    budget: { max_total_tokens: 20_000, on_exceed: "needs_user" },
    status: "confirmed",
    confirmation_source: "codex_conversation",
    created_at: "2026-07-30T00:01:02.000Z",
    confirmed_at: "2026-07-30T00:01:03.000Z",
  });
  const tasks = compileIntentArtifactTasks({
    intent,
    plan,
    available_lids: book.availableLids,
    resolved_scope_lids: book.availableLids,
  });
  const accepted = tasks.slice(0, 2).map((task, index) => {
    const payload = index === 0
      ? {
          version: "artifact_instance.v2",
          blueprint_digest: task.artifact.blueprint_digest,
          records: [{
            record_id: `record-aa11-one-off-${book.profile}`,
            data: { excerpt: `${book.bodySentinel} ${book.excerpt}`, category: book.profile },
            evidence_lids: [book.lid],
          }],
        }
      : {
          version: "artifact_instance.v2",
          blueprint_digest: task.artifact.blueprint_digest,
          records: [{
            record_id: `record-aa11-preset-${book.profile}`,
            data: { label: book.excerpt, order_hint: "AA11 preset reuse" },
            evidence_lids: [book.lid],
          }],
        };
    const candidate = {
      version: "intent_artifact_candidate.v2",
      task_id: task.task_id,
      book_id: task.book_id,
      source_fingerprint: task.source_fingerprint,
      intent_id: task.intent_id,
      intent_digest: task.intent_digest,
      plan_id: task.plan_id,
      plan_digest: task.plan_digest,
      artifact_id: task.artifact.artifact_id,
      blueprint_digest: task.artifact.blueprint_digest,
      payload,
    };
    return acceptIntentArtifactCandidate({
      task,
      candidate,
      current_intent: intent,
      current_plan: plan,
      current_source_fingerprint: book.sourceFingerprint,
      available_lids: book.availableLids,
      resolved_scope_lids: book.availableLids,
      accepted_at: `2026-07-30T00:01:0${4 + index}.000Z`,
    }).accepted;
  });
  return { intent, intentDigest, plan, accepted, privateArtifacts };
}

function installSelections(book, legacy, v2) {
  const root = path.join(privateRoot, book.bookId);
  writeJson(path.join(root, "intents", legacy.intent.intent_id, "intent.json"), legacy.intent);
  writeJson(path.join(root, "plans", `${legacy.plan.plan_id}.json`), legacy.plan);
  writeJson(
    path.join(root, "artifacts", legacy.intent.intent_id, legacy.artifactId, "accepted.json"),
    legacy.accepted,
  );
  writeJson(path.join(root, "intents", v2.intent.intent_id, "intent.json"), v2.intent);
  writeJson(path.join(root, "plans", `${v2.plan.plan_id}.json`), v2.plan);
  for (const accepted of v2.accepted) {
    writeJson(
      path.join(root, "artifacts", v2.intent.intent_id, accepted.artifact_id, "accepted.json"),
      accepted,
    );
  }
  const index = {
    version: "intent_artifact_store_index.v1",
    book_id: book.bookId,
    store_revision: 1,
    intents: {
      [legacy.intent.intent_id]: indexIntent(legacy.intent),
      [v2.intent.intent_id]: indexIntent(v2.intent),
    },
    plans: {
      [legacy.plan.plan_id]: indexPlan(legacy.plan),
      [v2.plan.plan_id]: indexPlan(v2.plan),
    },
  };
  writeJson(path.join(root, "index.json"), index);
}

function indexIntent(intent) {
  return {
    intent_id: intent.intent_id,
    revision: intent.revision,
    status: intent.status,
    source_fingerprint: intent.source_fingerprint,
  };
}

function indexPlan(plan) {
  return {
    plan_id: plan.plan_id,
    revision: plan.revision,
    status: plan.status,
    plan_digest: plan.plan_digest,
    intent_id: plan.intent_id,
  };
}

function setActive(book, selection) {
  const indexPath = path.join(privateRoot, book.bookId, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.store_revision += 1;
  if (selection) {
    index.active_overlay = {
      intent_id: selection.intent.intent_id,
      plan_id: selection.plan.plan_id,
    };
  } else {
    delete index.active_overlay;
  }
  writeJson(indexPath, index);
}

function deleteV2Selection(book, v2) {
  const root = path.join(privateRoot, book.bookId);
  const indexPath = path.join(root, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  delete index.intents[v2.intent.intent_id];
  delete index.plans[v2.plan.plan_id];
  delete index.active_overlay;
  index.store_revision += 1;
  writeJson(indexPath, index);
  for (const target of [
    path.join(root, "intents", v2.intent.intent_id),
    path.join(root, "plans", `${v2.plan.plan_id}.json`),
    path.join(root, "artifacts", v2.intent.intent_id),
  ]) {
    assert(path.resolve(target).startsWith(`${path.resolve(root)}${path.sep}`), "AA11 delete escaped the isolated private book root");
    rmSync(target, { recursive: true, force: true });
    assert(!existsSync(target), "AA11 isolated hard-delete target still exists");
  }
}

function selectionEnvelope(selection) {
  return {
    version: selection.intent.version === "build_intent.v2"
      ? "build_intent_selection.v2"
      : "build_intent_selection.v1",
    mode: "goal_directed",
    intent: selection.intent,
    intent_digest: selection.intentDigest,
    plan: selection.plan,
    estimate_input: null,
    decision_request: null,
  };
}

function runSync(program, args, { input, env = process.env, label, expectedStatus = 0, timeout = 60_000 } = {}) {
  const result = spawnSync(program, args, {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, expectedStatus, `${label ?? program} failed: ${result.stderr}`);
  return result;
}

function sidecarJson(command, body) {
  const result = runSync(packagedSidecar, [command], {
    input: JSON.stringify(body),
    label: `packaged ${command}`,
  });
  return { parsed: JSON.parse(result.stdout), raw: `${result.stdout}\n${result.stderr}` };
}

function auditPackagedContracts(book, legacy, v2) {
  const oneOff = v2.privateArtifacts[0].blueprint;
  const oneOffResolution = sidecarJson("intent.blueprint", {
    version: "artifact_blueprint_registry_command.v1",
    operation: "resolve",
    input: {
      private_root: registryRoot,
      blueprint_id: oneOff.blueprint_id,
      blueprint_version: oneOff.blueprint_version,
      one_off: oneOff,
    },
  });
  assert.equal(oneOffResolution.parsed.source, "one_off", "packaged sidecar did not resolve the one-off Blueprint");

  const systemShadow = { ...structuredClone(oneOff), blueprint_id: "system.timeline", blueprint_version: "1.0.0" };
  const presetResolution = sidecarJson("intent.blueprint", {
    version: "artifact_blueprint_registry_command.v1",
    operation: "resolve",
    input: {
      private_root: registryRoot,
      blueprint_id: "system.timeline",
      blueprint_version: "1.0.0",
      one_off: systemShadow,
    },
  });
  assert.equal(presetResolution.parsed.source, "system", "system preset did not win packaged resolution");

  for (const selection of [legacy, v2]) {
    const projected = sidecarJson("intent.plan", {
      operation: "project_codex",
      selection: selectionEnvelope(selection),
    });
    assert.equal(
      projected.parsed.version,
      selection.intent.version === "build_intent.v2"
        ? "codex_build_intent_plan.v2"
        : "codex_build_intent_plan.v1",
      "packaged plan projection changed the contract version",
    );
    assert(!projected.raw.includes(book.goalSentinel), "packaged sidecar leaked the private goal");
    assert(!projected.raw.includes("user_goal"), "packaged sidecar leaked the private goal key");
    assert.equal(projected.parsed.plan?.plan_id, selection.plan.plan_id, "packaged plan projection changed plan identity");
  }
}

function auditDesktopController(book, v2) {
  const command = {
    version: "codex_build_intent_command.v1",
    operation: "status",
    target: { workspace_dir: book.cloneDir },
    input: { plan_id: v2.plan.plan_id },
  };
  const result = runSync(installedDesktop, ["--codex-build-intent"], {
    input: JSON.stringify(command),
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      UNDERSTAND_BOOK_PRIVATE_DIR: privateRoot,
      UNDERSTAND_BOOK_BUILD_EXE: packagedSidecar,
    },
    label: "packaged Desktop stdin controller",
  });
  const raw = `${result.stdout}\n${result.stderr}`;
  assert(!raw.includes(book.goalSentinel), "Desktop controller leaked the private goal");
  assert(!raw.includes(book.bodySentinel), "Desktop controller leaked accepted artifact body");
  const response = JSON.parse(result.stdout);
  assert.equal(response.version, "codex_build_intent_response.v1");
  assert.equal(response.projection?.version, "codex_build_intent_plan.v2");
  assert.equal(response.projection?.plan?.plan_id, v2.plan.plan_id);
  assert.equal(response.projection?.plan?.private_artifacts?.length, 0);
  assert.equal(response.projection?.plan?.artifact_summaries?.length, 3);
  return { status_projection: true, artifact_summaries: response.projection.plan.artifact_summaries.length };
}

class McpClient {
  constructor(book) {
    this.book = book;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.calls = 0;
  }

  async start() {
    const plugin = JSON.parse(readFileSync(path.join(repoRoot, ".mcp.json"), "utf8"));
    const server = plugin.mcpServers?.book;
    assert(server?.command === "cmd.exe" && Array.isArray(server.args), "plugin Book MCP launcher is invalid");
    this.child = spawn(server.command, server.args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        UNDERSTAND_BOOK_MCP_BIN: packagedMcp,
        UNDERSTAND_BOOK_DIR: this.book.cloneDir,
        UNDERSTAND_BOOK_PRIVATE_DIR: privateRoot,
        UNDERSTAND_BOOK_MEMORY_DIR: path.join(smokeRoot, "mcp-memory", this.book.profile),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString()));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code) => this.rejectAll(new Error(`Book MCP exited ${code}: ${this.stderr}`)));
    const listed = await this.request("tools/list");
    const names = listed.tools?.map((tool) => tool.name) ?? [];
    for (const name of ["artifact_list", "artifact_search", "artifact_read", "book_text"]) {
      assert(names.includes(name), `packaged plugin tools/list is missing ${name}`);
    }
    return this;
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Book MCP ${method} timed out: ${this.stderr}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  async call(name, args) {
    this.calls += 1;
    return this.request("tools/call", { name, arguments: args });
  }

  async close() {
    if (!this.child || this.child.killed) return;
    const closed = new Promise((resolve) => this.child.once("close", resolve));
    this.child.stdin.end();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (!this.child.killed) this.child.kill();
  }
}

function structured(result) {
  assert(!result.isError, `MCP call failed: ${JSON.stringify(result.structuredContent)}`);
  return result.structuredContent;
}

function expectMcpError(result, allowedCodes) {
  assert.equal(result.isError, true, "MCP failure path returned success");
  const code = result.structuredContent?.error_code;
  assert(allowedCodes.includes(code), `unexpected MCP error code: ${code}`);
  return code;
}

async function auditMcp(book, legacy, v2) {
  const client = await new McpClient(book).start();
  const initial = await client.call("artifact_list", {});
  const noOverlayCode = expectMcpError(initial, ["ARTIFACT_OVERLAY_UNAVAILABLE"]);

  setActive(book, legacy);
  const legacyList = structured(await client.call("artifact_list", {}));
  assert.equal(legacyList.artifacts.length, 1, "legacy active overlay must expose one accepted artifact");
  assert.equal(legacyList.artifacts[0].title, "Comparison table");
  const legacyRef = legacyList.artifacts[0].artifact_ref;
  const legacySearch = structured(await client.call("artifact_search", {
    query: book.searchTerm,
    artifact_refs: [legacyRef],
  }));
  assert.equal(legacySearch.hits.length, 1, "v1 adapter search did not hit the real-book record");
  const legacyRead = structured(await client.call("artifact_read", { artifact_ref: legacyRef }));
  assert.equal(legacyRead.records.length, 1);
  assert(Array.isArray(legacyRead.records[0].data.dimensions), "v1 comparison adapter did not normalize dimensions");

  setActive(book, v2);
  const v2List = structured(await client.call("artifact_list", {}));
  assert.equal(v2List.artifacts.length, 2, "pending artifacts must not enter the access snapshot");
  const oneOffCard = v2List.artifacts.find((artifact) => artifact.title.startsWith("AA11 "));
  const presetCard = v2List.artifacts.find((artifact) => artifact.title === "Timeline");
  assert(oneOffCard && presetCard, "one-off and preset Routing Cards are not both visible");
  for (const card of [oneOffCard, presetCard]) {
    const search = structured(await client.call("artifact_search", {
      query: book.searchTerm,
      artifact_refs: [card.artifact_ref],
      anchor_lids: [book.lid],
    }));
    assert.equal(search.hits.length, 1, `real-book search missed ${card.title}`);
    assert(search.hits[0].evidence_lids.includes(book.lid), `${card.title} lost real LID evidence`);
    const read = structured(await client.call("artifact_read", {
      artifact_ref: card.artifact_ref,
      record_refs: [search.hits[0].record_ref],
    }));
    assert.equal(read.records.length, 1, `${card.title} read did not return its search hit`);
  }
  const oldRef = await client.call("artifact_read", { artifact_ref: legacyRef });
  const replanCode = expectMcpError(oldRef, ["ARTIFACT_REF_INVALID"]);

  writeFileSync(path.join(book.cloneDir, "source.txt"), Buffer.concat([
    book.sourceBytes,
    Buffer.from("\nAA11 isolated source-stale probe\n", "utf8"),
  ]));
  const stale = await client.call("artifact_list", {});
  const staleCode = expectMcpError(stale, ["INTENT_BUILD_CONFLICT", "ARTIFACT_OVERLAY_UNAVAILABLE"]);
  writeFileSync(path.join(book.cloneDir, "source.txt"), book.sourceBytes);
  assert.equal(sha256(readFileSync(path.join(book.cloneDir, "source.txt"))), book.sourceFingerprint);

  const raw = JSON.stringify({ legacyList, legacySearch, legacyRead, v2List });
  assert(!raw.includes(book.goalSentinel), "MCP result leaked the private goal");
  assert(!raw.includes(privateRoot), "MCP result leaked the private store path");
  return {
    client,
    stats: {
      static_tools: true,
      initial_no_overlay_code: noOverlayCode,
      legacy_records: legacyRead.records.length,
      active_v2_artifacts: v2List.artifacts.length,
      replan_old_ref_code: replanCode,
      source_stale_code: staleCode,
      calls_before_delete: client.calls,
    },
  };
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function toolMessagesAfterLastUser(messages) {
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
  return messages.slice(lastUser + 1).filter((message) => message.role === "tool");
}

function lastUserContent(messages) {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function providerToolName(body, internalAlias) {
  const match = body.tools?.find((tool) => tool.function?.name === internalAlias);
  assert(match, `provider request did not expose ${internalAlias}`);
  return match.function.name;
}

function artifactRefFromToolMessages(messages) {
  const text = toolMessagesAfterLastUser(messages).map((message) => message.content ?? "").join("\n");
  const match = text.match(/ar1_[A-Za-z0-9_-]+/u);
  assert(match, "artifact.search result did not carry an opaque artifact_ref");
  return match[0];
}

function completion(message) {
  return {
    id: "aa11-mock-completion",
    object: "chat.completion",
    choices: [{ index: 0, finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
    usage: { total_tokens: 5 },
  };
}

function toolCompletion(id, name, args) {
  return completion({
    role: "assistant",
    content: null,
    tool_calls: [{
      id,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    }],
  });
}

async function startMockProvider(book, onReplan) {
  const requests = [];
  let replanApplied = false;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      requests.push(body);
      const messages = body.messages ?? [];
      const user = lastUserContent(messages);
      const toolMessages = toolMessagesAfterLastUser(messages);
      let result;
      if (user.includes("AA11_RELATED")) {
        if (toolMessages.length === 0) {
          result = toolCompletion(
            "aa11-artifact-search",
            providerToolName(body, "artifact_search"),
            { query: book.searchTerm, anchor_lids: [book.lid], limit: 3 },
          );
        } else if (toolMessages.length === 1) {
          if (!replanApplied) {
            onReplan();
            replanApplied = true;
          }
          result = toolCompletion(
            "aa11-artifact-read",
            providerToolName(body, "artifact_read"),
            { artifact_ref: artifactRefFromToolMessages(messages), limit: 3 },
          );
        } else if (toolMessages.length === 2) {
          result = toolCompletion(
            "aa11-book-text",
            providerToolName(body, "book_text"),
            { lid: book.lid },
          );
        } else if (toolMessages.length === 3) {
          result = toolCompletion(
            "aa11-source-present",
            providerToolName(body, "source_present"),
            { start_lid: book.lid },
          );
        } else {
          result = completion({ role: "assistant", content: "AA11 related audit answer", tool_calls: [] });
        }
      } else {
        result = completion({ role: "assistant", content: "AA11 direct audit answer", tool_calls: [] });
      }
      const encoded = JSON.stringify(result);
      response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
      response.end(encoded);
    } catch (error) {
      const encoded = JSON.stringify({ error: error instanceof Error ? error.message : String(error) });
      response.writeHead(500, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) });
      response.end(encoded);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function fetchJson(url, init = {}, expectedStatus = 200) {
  const response = await fetch(url, init);
  const text = await response.text();
  assert.equal(response.status, expectedStatus, `${url} returned ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function waitForServer(url, child, stderr) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Resident Server exited ${child.exitCode}: ${stderr()}`);
    try {
      await fetchJson(`${url}/api/book/manifest`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Resident Server startup timed out: ${stderr()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function traceCounts(outcome) {
  const tools = outcome.trace?.map((step) => step.tool) ?? [];
  const artifactCalls = tools.filter((tool) => tool.startsWith("artifact.")).length;
  return {
    turns: outcome.turns,
    tokens_spent: outcome.tokens_spent,
    artifact_calls: artifactCalls,
    artifact_search_calls: tools.filter((tool) => tool === "artifact.search").length,
    artifact_read_calls: tools.filter((tool) => tool === "artifact.read").length,
    book_text_calls: tools.filter((tool) => tool === "book.text").length,
    source_present_calls: tools.filter((tool) => tool === "source.present").length,
  };
}

async function newAgentSession(url) {
  await fetchJson(`${url}/api/agent/new`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

async function agentChat(url, message) {
  return fetchJson(`${url}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
}

async function auditReaderAndResident(book, legacy, v2) {
  const mock = await startMockProvider(book, () => setActive(book, legacy));
  const port = await freePort();
  let stderr = "";
  let stdout = "";
  const server = spawn(residentServer, [book.cloneDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      UNDERSTAND_BOOK_ADDR: `127.0.0.1:${port}`,
      UNDERSTAND_BOOK_PRIVATE_DIR: privateRoot,
      UNDERSTAND_BOOK_MEMORY_DIR: path.join(smokeRoot, "resident-memory", book.profile),
      UNDERSTAND_BOOK_PROVIDER: "native",
      OPENCODE_API_KEY: "aa11-local-mock",
      OPENCODE_BASE_URL: mock.url,
      FLUID_LLM_MODEL: "aa11-scripted",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  server.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  server.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  const url = `http://127.0.0.1:${port}`;
  try {
    setActive(book, legacy);
    await waitForServer(url, server, () => stderr);
    const legacyReader = await fetchJson(`${url}/api/build_intent/artifacts`);
    assert.equal(legacyReader.overlay.artifacts.length, 1);
    assert.equal(legacyReader.overlay.artifacts[0].blueprint.title, "Comparison table");
    assert.equal(legacyReader.overlay.artifacts[0].state, "accepted");

    setActive(book, v2);
    const v2Reader = await fetchJson(`${url}/api/build_intent/artifacts`);
    const acceptedCount = v2Reader.overlay.artifacts.filter((artifact) => artifact.state === "accepted").length;
    const pendingCount = v2Reader.overlay.artifacts.filter((artifact) => artifact.state === "pending").length;
    assert.equal(acceptedCount, 2);
    assert.equal(pendingCount, 1);
    const readerRaw = JSON.stringify(v2Reader);
    assert(!readerRaw.includes(book.goalSentinel), "Reader overlay leaked the private goal");
    assert(!readerRaw.includes(privateRoot), "Reader overlay leaked the private store path");

    await newAgentSession(url);
    const relatedStarted = performance.now();
    const relatedOutcome = await agentChat(
      url,
      `AA11_RELATED Use the matching ${book.profile} artifact, then retrieve canonical Book evidence.`,
    );
    const relatedWallClockMs = Math.round(performance.now() - relatedStarted);
    const related = { ...traceCounts(relatedOutcome), wall_clock_ms: relatedWallClockMs };
    assert.equal(related.artifact_search_calls, 1, "related Resident question must use one initial artifact.search");
    assert.equal(related.artifact_read_calls, 1, "related Resident question must read the frozen artifact snapshot");
    assert.equal(related.book_text_calls, 1, "artifact-guided fact answer must refetch canonical Book evidence");
    assert.equal(related.source_present_calls, 1, "artifact-guided fact answer must present canonical Book evidence");
    assert.equal(relatedOutcome.incomplete, false);
    assert(!JSON.stringify(relatedOutcome).includes(book.bodySentinel), "Resident public outcome leaked artifact body");
    assert(!JSON.stringify(relatedOutcome).includes(book.goalSentinel), "Resident public outcome leaked private goal");

    setActive(book, v2);
    await newAgentSession(url);
    const unrelatedOutcome = await agentChat(url, "AA11_UNRELATED What controls the Reader panel width?");
    const unrelated = traceCounts(unrelatedOutcome);
    assert.equal(unrelated.artifact_calls, 0, "unrelated Resident question called artifact tools");

    await newAgentSession(url);
    const disabledOutcome = await agentChat(url, "AA11_DISABLED 不用产物，只根据原文说明这一段。");
    const userDisabled = traceCounts(disabledOutcome);
    assert.equal(userDisabled.artifact_calls, 0, "user-disabled Resident question called artifact tools");

    const requestBodies = mock.requests.map((request) => JSON.stringify(request));
    assert(requestBodies.every((body) => !body.includes(book.goalSentinel)), "Provider request leaked private goal");
    const relatedRequests = mock.requests.filter((request) => lastUserContent(request.messages ?? []).includes("AA11_RELATED"));
    const unrelatedRequests = mock.requests.filter((request) => lastUserContent(request.messages ?? []).includes("AA11_UNRELATED"));
    const disabledRequests = mock.requests.filter((request) => lastUserContent(request.messages ?? []).includes("AA11_DISABLED"));
    assert(relatedRequests.length >= 5, "related Resident loop did not complete the audited tool chain");
    assert(!JSON.stringify(relatedRequests[0]).includes(book.bodySentinel), "Routing request injected accepted body before search");
    assert(unrelatedRequests.every((request) => !JSON.stringify(request).includes(book.bodySentinel)), "durable history retained artifact body");
    assert(disabledRequests.every((request) => (
      !(request.tools ?? []).some((tool) => tool.function?.name === "artifact_search")
      && !JSON.stringify(request).includes("artifact_routing_cards.v1")
    )), "source-only directive did not hide artifact tools and Routing Cards");

    return {
      reader: {
        legacy_accepted: 1,
        v2_accepted: acceptedCount,
        v2_pending: pendingCount,
        current_only_after_replan: true,
      },
      resident: {
        related,
        unrelated,
        user_disabled: userDisabled,
        replan_during_turn_kept_frozen_snapshot: true,
        routing_body_injected_before_search: false,
        durable_artifact_body_retained: false,
      },
    };
  } finally {
    await stopChild(server);
    await mock.close();
    void stdout;
  }
}

async function auditBook(book) {
  const legacy = createLegacySelection(book);
  const v2 = createV2Selection(book);
  installSelections(book, legacy, v2);
  setActive(book, null);
  auditPackagedContracts(book, legacy, v2);

  const mcp = await auditMcp(book, legacy, v2);
  try {
    setActive(book, v2);
    const desktop = auditDesktopController(book, v2);
    const { reader, resident } = await auditReaderAndResident(book, legacy, v2);
    setActive(book, v2);
    deleteV2Selection(book, v2);
    const deleted = await mcp.client.call("artifact_list", {});
    const deleteCode = expectMcpError(deleted, ["ARTIFACT_OVERLAY_UNAVAILABLE"]);
    const consistent = reader.v2_accepted === mcp.stats.active_v2_artifacts
      && resident.related.artifact_search_calls === 1
      && resident.related.artifact_read_calls === 1;
    assert(consistent, "Reader, Resident, and MCP active accepted views diverged");
    return {
      book_id: book.bookId,
      profile: book.profile,
      real_book: { lid_count: book.lidCount, evidence_lids_used: 1 },
      blueprints: { preset_reuse: true, one_off: true, v1_adapter: true, pending_excluded: true },
      packaged: { desktop, sidecar_contracts: true, plugin_mcp_static_tools: true },
      consumers: {
        reader,
        resident: { active_accepted: reader.v2_accepted },
        mcp: mcp.stats,
        consistent,
      },
      resident,
      fail_closed: {
        no_overlay: mcp.stats.initial_no_overlay_code,
        replan_old_ref: mcp.stats.replan_old_ref_code,
        source_stale: mcp.stats.source_stale_code,
        delete: deleteCode,
        history_not_active: true,
        pending_not_readable: true,
        all_passed: true,
      },
    };
  } finally {
    await mcp.client.close();
  }
}

await runAudit();
