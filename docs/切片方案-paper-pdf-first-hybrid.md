# Slice Plan - Paper PDF-first reconciled source

> Positioning: replace the paper MVP "Markdown-only reader" with a PDF-first reader while preserving LID/range as the only semantic, memory, and citation anchor.
> Frozen decision: ADR-0063 and ADR-0064.
> Status: v2 design landed; implementation not started.

## 0. Locked Decisions

1. `paper.md + paper.pdf` are inputs. Trusted `source.txt` is generated only after source reconciliation passes deterministic gates.
2. LID spans, `book.text`, notes, highlights, citations, sidecars, and paper projections are derived from reconciled `source.txt`.
3. PDF page/bbox data is visual provenance only. It can project LIDs onto PDF pages but cannot become citation or memory truth.
4. `source_manifest.v2` is the book-level PDF capability manifest. `profileManifest` says what a profile can do; `source_manifest` says what this book can do.
5. `pdf_source_map.json` is lightweight and public to the frontend for overlay, hit-test, and LID jump.
6. `pdf_selection_map/` is backend-only, char-level, and sharded by page for PDF selection resolve and semantic range projection.
7. Heavy provenance lives in `alignment_report.json`, not in runtime maps.
8. Build Workbench is separate from normal reader state. Missing, incomplete, stale, or review-required source inputs cannot enter the normal reader.
9. `.build/<stage>` contains accepted stage artifacts; `.build/jobs/<job_id>` contains orchestration logs, telemetry, active executor state, and user events.
10. LLM review is format-only and cannot alter content. Accepted LLM candidates must pass deterministic `content_equivalence` and realignment gates.
11. Zotero document-worker remains an architecture reference only. No Zotero source, tests, fixtures, bundle paths, ONNX models, wasm assets, or forked pdf.js paths enter this project.
12. The Grill traceability ledger in section 7 is part of this plan. New implementation slices must keep every Grill item covered, superseded, or explicitly deferred.

## 1. End-to-End Flow

```text
open target
  -> readiness detection
  -> trusted_book: normal reader
  -> missing | incomplete | needs_review | stale: Build Workbench
```

```text
Build Workbench stage DAG:

source_reconciliation
  -> hybrid_foundation
      -> pass1
          -> paper_metadata
          -> paper_lexicon
          -> profile_sidecar
              -> pass2
                  -> book_structure
                      -> finalize
```

```text
source_reconciliation:
  paper.md + paper.pdf
  -> deterministic text/geometry extraction
  -> safe layout/encoding repair
  -> optional LLM format repair
  -> content_equivalence gate
  -> source_reconciliation_report.json
  -> source.txt only if unresolved == 0
```

```text
hybrid_foundation:
  source.txt
  -> markdownToBlocks()
  -> segment(SourceBlock[])
  -> base.json
  -> source_manifest.v2
  -> pdf_source_map.json
  -> pdf_selection_map/manifest.json + pages/*.json
  -> alignment_report.json
```

## 2. Artifact Contracts

```ts
type SourceBlockReconcileStatus =
  | "verified"
  | "auto_repaired"
  | "llm_format_repaired"
  | "needs_review"
  | "pdf_unmatched"
  | "md_unmatched";

interface SourceReconciliationReport {
  version: "source_reconciliation_report.v1";
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  summary: Record<SourceBlockReconcileStatus, number>;
  unresolved: Array<{ id: string; status: SourceBlockReconcileStatus; reason: string }>;
}
```

```ts
interface AlignmentReport {
  version: "alignment_report.v1";
  book_id: string;
  config: {
    algorithm: "monotonic_forward_fuzzy_v1";
    lookback_words: number;
    lookahead_words: number;
    merge_gap_utf16: number;
    coordinate_system: "pdf_user_space";
    normalization: string[];
  };
  config_hash: string;
  hard_gates: Record<string, boolean | number>;
  diagnostics: Record<string, unknown>;
  normalization_provenance: Array<{ trace_id: string; summary: string }>;
}
```

```ts
type PdfCapabilityStatus =
  | "unavailable"
  | "available"
  | "degraded"
  | "stale"
  | "failed";

interface SourceManifestV2 {
  version: "source_manifest.v2";
  book_id: string;
  canonical_source: {
    kind: "reconciled_markdown";
    path: "source.txt";
    citation_anchor: "lid";
    sha256: string;
  };
  original_pdf?: {
    path: string;
    sha256: string;
    fingerprint?: string;
    citation_anchor: false;
  };
  capabilities: {
    view_pdf: PdfCapability;
    project_lid_to_pdf: PdfCapability;
    resolve_pdf_selection: PdfCapability;
    project_ranges_to_pdf: PdfCapability;
  };
}

interface PdfCapability {
  status: PdfCapabilityStatus;
  reason?: string;
  artifact_path?: string;
  report_path?: string;
  config_hash?: string;
}
```

```ts
interface PdfSourceMap {
  version: "pdf_source_map.v1";
  book_id: string;
  coordinate_system: {
    space: "pdf_user_space";
    origin: "bottom_left";
    unit: "pt";
    rotation_applied: false;
  };
  pages: PdfPageMeta[];
  entries: PdfSourceMapEntry[];
  excluded_regions: PdfExcludedRegion[];
  page_region_index: Record<string, string[]>;
  page_excluded_index: Record<string, string[]>;
  config_hash: string;
}

interface PdfPageMeta {
  pageIndex: number;
  page_label?: string;
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  view: [number, number, number, number];
}

interface PdfSourceMapEntry {
  lid: string;
  source_span: { start: number; end: number };
  status: "word_mapped" | "line_fallback" | "block_fallback" | "unmapped" | "excluded";
  regions: PdfRegion[];
  primary_region?: PdfRegion;
  alignment: { confidence: number; reason?: string; trace_id?: string };
}
```

```ts
interface PdfSelectionResolveResponse {
  status: "resolved" | "partial" | "unresolved";
  quote_markdown: string;
  ranges: Array<{ lid: string; range: { start: number; end: number } }>;
  representative_lid?: string;
  unresolved_rects?: PdfPageRect[];
}
```

```ts
interface BuildDecisionRequest {
  decision_id: string;
  job_id: string;
  stage: BuildStageId;
  kind:
    | "source_reconciliation_mode"
    | "hybrid_source_strategy"
    | "alignment_repair_strategy"
    | "executor_selection"
    | "review_acceptance"
    | "artifact_conflict_resolution"
    | "continue_or_restart";
  options: Array<{ id: string; label: string; consequence: string; recommended?: boolean }>;
  blocks_stage_until_answered: boolean;
}
```

```ts
interface BuildJobState {
  job_id: string;
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  status: "ready" | "running" | "needs_user" | "failed" | "done" | "stale_input";
  active_run?: { stage: BuildStageId; unit_id?: string; executor: "codex" | "opencode" | "claude" | "manual" };
}

interface ExecutorPermissionRequest {
  request_id: string;
  run_id: string;
  executor: "codex" | "opencode" | "claude" | "manual";
  category: "sandbox_escalation" | "network" | "filesystem" | "mcp_tool" | "skill_script" | "shell_command" | "destructive_action" | "other";
  action_summary: string;
  scope_hint: "once" | "stage" | "job" | "profile";
  native?: unknown;
}
```

## 3. Implementation Slices

### PH0 - ADR and v2 contract landing

- **Do**: supersede ADR-0062 where needed, land ADR-0063, update this slice plan, and update glossary terms.
- **Do not**: change TS/Rust implementation.
- **Done**: docs clearly state that PDF-first `source.txt` is reconciled canonical source.

### PH1 - Source reconciliation schema and fixtures

- **Do**: add schemas and tiny born-digital fixture pair for `source_reconciliation_report.v1`, `source_manifest.v2`, `pdf_source_map.v1`, and `pdf_selection_map` manifest/page shards.
- **Do not**: implement full PDF reader or paper sidecar extraction.
- **Done**: schema tests cover verified, auto-repaired, needs-review, stale, and capability-disabled states.

### PH2 - Clean-room PDF text geometry adapter

- **Do**: use official `pdfjs-dist` through a project-owned build adapter to extract page metadata, chars, words, lines, PDF user-space bboxes, and page labels.
- **Do not**: copy Zotero code/assets, parse scanned OCR, or infer semantic structure.
- **Done**: deterministic fixture test proves char/word/line geometry and page metadata extraction.

### PH3 - Source reconciliation engine

- **Do**: reconcile `paper.md + paper.pdf`, use monotonic forward fuzzy alignment with bounded lookback, apply only safe deterministic layout/encoding repairs, emit review artifacts when unresolved, and block trusted output on unresolved content.
- **Do not**: write `source.txt/base.json` when unresolved issues remain.
- **Done**: trusted output exists only when unresolved count is zero; otherwise `.build/source-reconciliation/*` exists and build exits non-zero.

### PH4 - Optional LLM format review and human review artifacts

- **Do**: support `llm review` as format-only repair with `content_equivalence` and realignment gates; support manual review artifacts `reviewed-draft.md` and `review-decisions.json`.
- **Do not**: allow LLM content edits, LLM page/bbox claims, or UI state to bypass deterministic gates.
- **Done**: accepted LLM/manual changes re-enter the same reconciliation gates before trusted output.

### PH5 - Hybrid foundation close

- **Do**: from trusted `source.txt`, write `base.json`, `source_manifest.v2`, `pdf_source_map.json`, `pdf_selection_map/*`, and `alignment_report.json`.
- **Do not**: run paper metadata, lexicon, discourse, Pass2, or BookStructure in this slice.
- **Done**: source/map freshness hashes agree; hard gates pass; degraded PDF capabilities are explicit.

### PH6 - Build Workbench minimum shell

- **Do**: add build-mode readiness detection, `BuildJob` stage DAG, input fingerprint stale detection, same-input incomplete job reuse, job events, active executor telemetry, executor adapters, `BuildDecisionRequest`, and `ExecutorPermissionRequest` handling.
- **Do not**: mount this inside normal `/reader/*` state or mark stage done from job state alone.
- **Done**: missing/incomplete/review-required targets route to Workbench; trusted books route to reader.

### PH7 - PDF reader surface and endpoints

- **Do**: add `/book/source_manifest`, `/book/pdf/original`, `/book/pdf_source_map`, `/reader/pdf_selection.resolve`, and `/reader/pdf_ranges.project`; add `PdfReaderPane` as mutually exclusive center surface when PDF capability is available; load full public `pdf_source_map` once; use all page shells with lazy canvas/text/overlay rendering.
- **Do not**: implement PDF annotation write-back, OCR, thumbnails, printing, or persistent side-by-side Markdown/PDF reader.
- **Done**: LID jump scrolls to `primary_region`; unmapped LIDs open Markdown source preview; PDF selection saves semantic LID ranges.

### PH8 - Paper projection chain on trusted source

- **Do**: run existing paper metadata, lexicon, discourse, Pass2, BookStructure, and PaperReadingGuide against trusted reconciled `source.txt`.
- **Do not**: let paper projection failures redefine source truth.
- **Done**: existing paper projection smoke passes on a reconciled fixture.

### PH9 - Natural-language sidecar planning follow-up

- **Do**: add confirmable `sidecar_plan.json` / form drafts with default sidecar options before custom sidecar generation.
- **Do not**: block PH1-PH8 on natural-language sidecar UX.
- **Done**: Q68 is implemented as its own Build Workbench extension slice.

### PH10 - Build Workbench snapshot page (minimum frontend shell)

- **Do**: add a dedicated frontend route/page for pre-reader build state; consume existing readiness, job, event, decision, permission, and sidecar plan artifacts; show the stage DAG with source reconciliation, hybrid foundation, Pass1, and paper projection status; keep `BuildDecisionRequest` and `ExecutorPermissionRequest` as separate display flows; let users confirm/edit PH9 `sidecar_plan.json` form drafts before custom sidecar generation.
- **Do not**: accept uploads, create/resume build jobs, start Codex/opencode/Claude/manual executors, approve executor permissions, mark stages done from job state alone, mix Workbench state into normal `/reader/*`, or hide stale/needs_review targets behind the reader.
- **Done**: missing, stale, needs_review, and incomplete books open a snapshot Workbench shell; trusted books open the reader; source review and sidecar plan artifacts are visible before artifact trust. This is not the complete Build Workbench controller.

### PH11 - PDF.js body reader surface

- **Do**: replace the minimal/native PDF surface with a controlled official `pdfjs-dist` body reader; render canvas pages, text-layer geometry for selection, all page shells with lazy page rendering, LID overlays from `pdf_source_map`, selection to `/reader/pdf_selection.resolve`, semantic range projection to `/reader/pdf_ranges.project`, and source preview fallback for unmapped LIDs.
- **Do not**: add OCR for scanned PDFs, PDF annotation write-back, page/bbox citation anchors, Zotero code/assets, permanent Markdown/PDF split reader, thumbnails, or printing unless scoped later.
- **Done**: PDF text body is rendered by project-controlled PDF.js pages, LID jump/selection/range projection work in UI, and citations/highlights still persist only LID/range.

## 3.1 Complete Build Workbench Completion Plan

Target contract:

```text
Build Workbench = pre-reader build controller

paper.md + paper.pdf uploaded or selected by user
  -> untrusted draft workspace + input manifest + fingerprint
  -> create/reuse build job
  -> user selects executor (Codex first, manual fallback)
  -> server-side build controller starts executor
  -> Workbench shows live/polled events, active run, token/cost, decisions, permissions
  -> user resolves source reconciliation and permission gates
  -> deterministic stage artifacts pass schema/hash/readiness gates
  -> trusted source.txt/base.json/source_manifest/maps exist
  -> route changes from workbench to reader
```

Hard boundary:
- Frontend never runs Codex or writes trusted artifacts directly.
- Job state is orchestration truth only; `.build/<stage>` artifacts plus deterministic gates remain reader trust truth.
- Uploaded inputs are untrusted until a stage writes accepted artifacts.
- Workbench is paper-profile build mode only; existing technical-learning books with trusted `base.json/source.txt` bypass paper gates and open reader.

### PH12 - Workbench import and draft workspace

- **Do**: add UI and server endpoints to upload or select `paper.md` and `paper.pdf`, create/open a draft paper build workspace, write an untrusted input manifest with file paths, sha256 hashes, profile id, display title, and config hash; return a `build_workbench_snapshot.v1` with current input fingerprint.
- **Do not**: write trusted `source.txt`, `base.json`, `source_manifest.json`, PDF maps, or paper sidecars in this slice; do not mount uploaded PDF as reader truth.
- **Done**: a Chinese user can start from an empty Workbench, provide PDF+MD, reopen the draft workspace, and see input readiness without entering the reader.

### PH13 - Build controller API and durable job lifecycle

- **Do**: add server-side build controller endpoints for create/reuse job, start/resume job, append job event, resolve `BuildDecisionRequest`, resolve `ExecutorPermissionRequest`, and refresh snapshot; persist `.build/jobs/<job_id>.json` atomically; reuse same-fingerprint incomplete jobs and mark stale jobs on input changes.
- **Do not**: infer stage success from job status, invent completed artifacts, or allow normal `/reader/*` state to mutate build jobs.
- **Done**: starting a build from Workbench creates/reuses a durable job; decisions and permissions round-trip through API and survive server restart.

### PH14 - Codex executor adapter skeleton

- **Do**: add a server-side Codex executor adapter behind the build controller; launch it with a scoped workdir, stage-specific prompt, explicit input/output contract, and no frontend shell execution; capture stdout/stderr, pid/heartbeat, command summary, token/cost telemetry when available, and map approval/escalation needs into `ExecutorPermissionRequest`.
- **Do not**: grant permissions automatically, pass arbitrary browser-supplied commands to shell, or let Codex write trusted artifacts outside the declared stage output paths.
- **Done**: a fake adapter is deterministically tested, and a real Codex-backed smoke path can create `executor_started`, permission, and completion/failure events without browser-side execution.

### PH15 - Interactive Workbench action UI

- **Do**: replace the static snapshot-only surface with controls for import/upload, executor choice, start/resume, refresh/polling, pending build decisions, pending executor permissions, active run telemetry, event log, and clear failure recovery; all visible text remains Chinese.
- **Do not**: hide unresolved/stale states behind a reader route, combine build decisions with executor permissions, or expose raw enum-only UI to Chinese users.
- **Done**: a user can drive a build from the Workbench UI until the next required decision/permission or completed trusted reader handoff.

### PH16 - Source reconciliation review surface

- **Do**: add a dedicated Workbench review panel for unresolved source reconciliation blocks; show Markdown/PDF evidence, candidate repaired text, unresolved reason, and decision options; write review decisions as build decision artifacts and rerun source reconciliation gates.
- **Do not**: accept arbitrary LLM content edits, use PDF page/bbox as citation truth, or resolve content-bearing conflicts without deterministic equivalence/realignment.
- **Done**: `needs_review` source reconciliation can be resolved from Workbench and either re-enter the trusted source pipeline or remain blocked with explicit reasons.

### PH17 - Stage runner wiring and reader handoff

- **Do**: wire build controller stages to existing PH1-PH9 scripts/runtime paths: source reconciliation, hybrid foundation close, PDF maps, paper projections, sidecar planning, and final readiness recomputation; after each stage, re-read artifacts and update snapshot; when trusted `source.txt/base.json/source_manifest/maps` pass gates, route to reader.
- **Do not**: make stage runners depend on frontend state, skip schema/hash gates, or let sidecar/projection failures redefine source truth.
- **Done**: from uploaded PDF+MD, the Workbench can run through trusted reader entry with deterministic gates as the only handoff authority.

### PH18 - Recovery, observability, and operational hardening

- **Do**: add stale-input warnings, orphaned active-run recovery, resumable polling after refresh, job failure summaries, permission audit trail, bounded job/event retention, and tests for interrupted/resumed builds.
- **Do not**: add multi-user queueing, distributed workers, background daemon assumptions, or cloud storage in this v1.
- **Done**: interrupted builds can be reopened safely, stale inputs cannot silently reuse old artifacts, and Workbench failures point to actionable stage/job/event details.

## 4. Hard Gates and Diagnostics

Hard gates:
- schema validation passes for source reconciliation, source manifest, source map, selection map manifest, and page shards.
- source reconciliation unresolved count is zero before trusted `source.txt/base.json`.
- `source_manifest.v2`, `pdf_source_map`, and `pdf_selection_map` freshness hashes agree.
- every source map entry references an existing leaf LID and original UTF-16 source span.
- every mapped PDF region has valid `pageIndex` and bbox inside unrotated PDF user-space page bounds.
- selection map shards match manifest hash and page identity.
- clean-room boundary is respected: no Zotero source, tests, models, bundles, wasm assets, or fork paths.

Diagnostics:
- mapped leaf ratio, word/line/block fallback ratios, unmapped ratio, mean/p10 confidence.
- excluded page furniture count and reasons.
- ambiguous match count and low-mapping pages.
- LLM format-review candidate count, rejected candidate count, and rejection reasons.

API gates:
- `GET /book/source_manifest` returns normalized `source_manifest.v2` for v2, converted legacy, and missing-manifest cases; invalid manifests return an error envelope.
- `GET /book/pdf_source_map` returns `200` only when `project_lid_to_pdf.status == available`; degraded, stale, failed, and unavailable states are explained by `/book/source_manifest`.
- `POST /reader/pdf_selection.resolve` returns HTTP `200` for business results `resolved | partial | unresolved`; request, capability, stale artifact, and shard failures use error envelopes.
- `GET /book/pdf/original` serves only the current book's manifest-declared PDF. v1 uses whole-buffer loading; `HEAD` and Range support are deferred from Q28 to a later performance slice.

## 5. Reader Semantics

```text
LID jump:
  if project_lid_to_pdf available and entry.primary_region exists:
    scroll PdfReaderPane to primary_region
    pulse all entry.regions
    call reader.goto(lid) for semantic sync
  else:
    open Markdown source preview
```

```text
PDF selection:
  browser text layer provides geometry only
  -> convert client rects to pdf_user_space
  -> POST /reader/pdf_selection.resolve
  -> backend returns quote_markdown from source-order LID ranges
  -> backend merges overlapping or adjacent ranges per LID
  -> existing highlight/note/Ask flows persist only LID/range
```

```text
Existing semantic annotation:
  LID/range memory
  -> POST /reader/pdf_ranges.project
  -> exact | lid_region_fallback | unmapped display rects
```

## 6. Non-goals for v1

- scanned PDF OCR.
- table/formula/figure semantic extraction from PDF layout.
- PDF annotation write-back.
- permanent Zotero-style PDF/Markdown split reader.
- page/bbox citation anchors.
- automatic content repair by LLM.
- treating Build Workbench job state as artifact truth.

## 7. Grill Traceability Patch Chapter

Status values:
- `covered`: explicitly represented in ADR-0063, this plan, or a named section above.
- `superseded`: an earlier Grill answer is intentionally replaced by a later Grill decision.
- `deferred`: not part of the PDF-first source foundation, but assigned to a named follow-up slice or non-goal.

| Grill item | Status | Current landing |
| --- | --- | --- |
| G1 text geometry chars/words/lines/pages | covered | PH2 clean-room PDF text geometry adapter |
| G2 PDF user-space coordinate system | covered | `PdfSourceMap.coordinate_system`, PH7 frontend conversion |
| G3 all leaf LIDs get mapping status | covered | `PdfSourceMapEntry.status`, hard gates |
| G4 monotonic forward alignment | covered | PH3 source reconciliation engine |
| G5 excluded page furniture | covered | `excluded_regions`, `page_excluded_index`, diagnostics |
| G6 coarse source-map-only selection | superseded | replaced by G7/G14 `pdf_selection_map` |
| G7 char-level selection map | covered | `pdf_selection_map`, PH7 selection endpoint |
| G8 normalized-to-raw offset maps | covered | `alignment_report.normalization_provenance`, original UTF-16 spans |
| G9 book-scoped PDF route | covered | `/book/pdf/original`, source manifest path rules |
| G10 hybrid foundation only | covered | PH5 excludes paper sidecar chain; PH8 runs later |
| G11 controlled pdf.js surface | covered | PH7 minimal `PdfReaderPane`; PH11 full PDF.js body reader |
| G12 PDF scroll syncs semantic LID | covered | Reader semantics: call `reader.goto(lid)` |
| G13 PDF selection aligns to existing popover model | covered | `PdfSelectionResolveResponse`, LID/range persistence |
| G14 early selection-map sharding | covered | `pdf_selection_map/manifest.json + pages/*.json` |
| G15a hard gates vs diagnostics | covered | section 4 hard gates and diagnostics |
| G16a degraded PDF fallback | covered | API gates: source manifest explains degraded/stale/failed capability |
| G17a source manifest status machine | covered | `source_manifest.v2` capability status |
| G18a LLM alignment-only repair | superseded | replaced by Q45/Q46 reconciled source + format-only LLM review |
| G19a normalization provenance | covered | `AlignmentReport.normalization_provenance` |
| G20a lightweight runtime map | covered | `pdf_source_map` public, heavy provenance in `alignment_report` |
| G21a explicit primary region | covered | `PdfSourceMapEntry.primary_region`, reader LID jump |
| G22a page region index | covered | `page_region_index` |
| G23 page excluded index | covered | `page_excluded_index` |
| G24 partial selection resolve | covered | `PdfSelectionResolveResponse.status` and API gates |
| G25 quote assembled in source order | covered | Reader semantics PDF selection |
| G26 merge adjacent selection ranges | covered | Reader semantics PDF selection |
| G14b sharded selection map | covered | same as G14 early |
| G15b semantic annotation back-projection | covered | `/reader/pdf_ranges.project` |
| G16b text-layer geometry only | covered | Reader semantics; browser text not quote truth |
| G17b page virtualization | superseded | replaced by Q36 all page shells + PH11 lazy PDF.js page rendering |
| G18b source-manifest-driven capability | covered | `source_manifest.v2`, API gates |
| G19b book-scoped PDF/map artifacts | covered | source manifest artifact paths and PH5 |
| G20b freshness hashes | covered | hard gates: manifest/map/selection hashes agree |
| G21b split PDF capabilities | covered | `SourceManifestV2.capabilities` |
| G22b page identity/labels/rotation | covered | `PdfPageMeta`, unrotated PDF user-space |
| G27 alignment config and config hash | covered | `AlignmentReport.config`, `config_hash`, `PdfSourceMap.config_hash` |
| G28 PDF route HEAD/Range | superseded | Q41 sets whole-buffer v1; Range deferred to performance slice |
| G29 REST boundaries | covered | API gates and PH7 endpoints |
| G30 source-map error semantics | covered | API gates: map `200` only when available |
| G31 selection resolve HTTP semantics | covered | API gates: business status in `200` body |
| G32 batch range projection | covered | `/reader/pdf_ranges.project` |
| G33 frontend coordinate conversion | covered | PDF user-space persisted; frontend converts locally |
| G34 PDF scroll through `reader.goto` | covered | Reader semantics |
| G35 official `pdfjs-dist` thin adapters | covered | PH2 build adapter and PH11 web rendering adapter |
| G36 all page shells + lazy canvas | covered | PH11 rendering rule |
| G37 deterministic citation jump | covered | `primary_region` and LID jump behavior |
| G38 mutually exclusive center surface | covered | PH7 `PdfReaderPane` vs HTML reader |
| G39 source manifest v2 | covered | `SourceManifestV2` |
| G40 frontend loads full public source map | covered | PH7 rule |
| G41 dedicated current-book PDF route | covered | `/book/pdf/original`, whole-buffer v1 |
| G42 source manifest endpoint normalization | covered | API gates |
| G43 capability status gates | covered | API gates and `PdfCapabilityStatus` |
| G44 sharded selection map | covered | `pdf_selection_map` backend shards |
| G45 reconciled canonical source | covered | ADR-0063, PH3/PH5 |
| G46 safe auto-repair and LLM format review | covered | PH3 and PH4 |
| G47 content equivalence gate | covered | PH4 and hard gates |
| G48 unresolved reconciliation blocks trusted build | covered | PH3 done criteria |
| G49 dedicated source reconciliation review page | covered | PH16 Workbench source reconciliation review surface; PH10 is snapshot shell only |
| G50 source review outside normal reader | covered | PH12-PH17 Workbench build mode keeps source review outside normal reader |
| G51 manual vs LLM review choice | covered | PH4 and `BuildDecisionRequest` |
| G52 noninteractive CLI prompt proposal | superseded | replaced by Q53 Build Workbench user-choice surface |
| G53 Codex/opencode executor feasibility | covered | PH14 Codex executor adapter skeleton; opencode remains adapter-neutral follow-up |
| G54 Workbench as build mode | covered | PH12-PH18 complete Workbench controller |
| G55 readiness gate before reader | covered | PH17 reader handoff recomputes deterministic readiness |
| G56 explicit stage DAG | covered | Build Workbench stage DAG plus PH15 interactive controls |
| G57 `state.json` snapshot not truth | covered | locked decision 9 and PH6 prohibition |
| G58 artifact root under book workspace | covered | `.understand-book/<book_id>/.build/<stage>` |
| G59 jobs are orchestration logs | covered | locked decision 9 |
| G60 job input fingerprint stale | covered | `BuildJobState.input_fingerprint`, PH13 and PH18 stale-input handling |
| G61 reuse incomplete same-input job | covered | PH13 durable job lifecycle |
| G62 user decisions dual-recorded | covered | ADR-0063 rule 11 and PH13 decision resolve API |
| G63 run-control events include Codex choices | covered | PH14 executor adapter and PH15 interactive run controls |
| G64 adapter-neutral permission schema | covered | `ExecutorPermissionRequest.native`, PH13/PH14 permission loop |
| G65 approval correction | covered | ADR-0063 rule 11, build-direction vs executor permission split |
| G66 `BuildDecisionRequest` separate from permissions | covered | artifact contract |
| G67 | covered | no Q67 exists in `grill.md`; ledger intentionally records the gap |
| G68 natural-language sidecar plan | covered | PH9 confirmable `sidecar_plan.json` / form draft before custom sidecar generation |
