# ADR-0075 Runtime-owned evidence-backed profile memory

Status: Accepted, 2026-07-13.

The current memory path depends on the resident agent voluntarily calling `memory.save` and `memory.recall`; a valid assistant reply may therefore finish without writing or consuming user context. The existing code-level `ReaderProfile` is also only a per-book deterministic aggregate of read/focus/qa LIDs, so it cannot represent a stable cross-book reader profile or explain when that profile affected an answer.

We will keep one local, cross-book `memory.json` truth source but migrate it from a bare `Vec<Record>` to a versioned `MemoryDocument` with separate content records, typed `ProfileFact` entries, durable review state, and evidence exclusions. Existing notes, highlights, qa, read history, citation gates, reader-private isolation, and one-way Markdown projections remain; profile facts add `scope` (global or book), independent `applicability` (any/content profile/subtype/domain), source, evidence references, trust status, lifecycle, and supersession.

Runtime, not the main agent, owns profile capture and consumption. Explicit remember/correct/forget intent goes through a foreground `MemoryIntentGate`; ordinary resident turns are durably queued after the assistant turn commits. A per-session `ReviewJob` extracts incremental candidate facts, then an event-driven global consolidation pass considers only ledger facts and independent cross-book evidence. Normal review is coalesced after 60 seconds idle, forced after eight unreviewed user turns, and drained at new-chat, book-switch, and context-compression boundaries. Watermarks make jobs idempotent and restartable; a bounded boundary wait may degrade to the last good snapshot plus bounded pending user context, but the stale state and error must be visible.

Trust and projection are source-sensitive. Deterministic reading actions and explicit user statements may become confirmed facts; agent-inferred book facts are provisional weak hints; agent-inferred global facts remain pending and cannot enter context until confirmed. Ambiguous statements made while reading default to book scope, while repeated evidence across at least two books and three independent observations may create a global promotion candidate. Current explicit instructions outrank all memory, user correction outranks weaker records, and objective reading state is reduced from deterministic events rather than model judgment.

The product-level reader profile is a bounded `ReaderProfileSnapshot` assembled automatically before each resident user turn from `GlobalReaderProfile`, current `BookReadingState`, applicable facts, and the active content profile's `MemoryPolicy`; it is not persisted in chat history and is not a second truth source. Core owns section budgets and serialization. A policy may rank typed candidates and derive rebuildable profile state, but it cannot alter trust, deletion, LID/citation rules, or inject free-form prompt text. `technical_learning` keeps raw activity separate from learning hypotheses; `paper` treats skim/close/deep and passive/active/critical/creative as explicit reading intent rather than inferred ability; unknown profiles use `NeutralMemoryPolicy`.

Every response records a `ProfileUsageTrace` that distinguishes facts deterministically injected by runtime from the model's constrained claim that it used them. The latter is weak telemetry, not causal proof. User-visible governance provides quiet update/undo, centralized pending review, evidence/source inspection, scope changes, correction, and deletion. Correction supersedes and remains auditable; “forget” hard-deletes the fact and derived copies while retaining only content-free excluded evidence IDs needed to prevent re-extraction.

Memory remains local plaintext for this MVP, restricted to the current OS user and never synced. Secrets are never stored; sensitive traits are never inferred automatically and require explicit plaintext acknowledgement if the user asks to retain them. Sensitive values are redacted from materialized Markdown. Application-level encryption, accounts, cross-device sync, and an executable `InteractionRoutine` model are outside this decision; non-binding `intent_key` observations may be retained only to measure whether a future routine model would earn its complexity, and never enter snapshots or trigger actions.

## Superseded and retained decisions

- This supersedes ADR-0038's and ADR-0039's reliance on foreground agent judgment and their blanket rejection of background extraction. Transparency is instead enforced by durable job status, evidence, trust states, user review, and hard deletion; the old `context` record remains ordinary context memory and is not silently promoted.
- This refines ADR-0033's Reader Profile boundary: the old code-level `ReaderProfile` becomes `BookReadingState`, while `ReaderProfileSnapshot` is the bounded product-level projection.
- ADR-0040's single truth source and one-way `reader-profile.md` / `reading-handbook.md` projections remain. Its “zero LLM because no producer exists” limitation is superseded by ReviewJob, but the Markdown files remain derived views and never become input truth.
- ADR-0041's qa record and deterministic count remain; interpreting that count universally as “puzzle” or mastery is superseded. Each `MemoryPolicy` decides how a raw qa activity signal affects reading.
- ADR-0035's resident/visitor privacy boundary remains: visitor/MCP and build-workbench sessions cannot read, generate, or mutate reader-private profile memory.

## Considered options

- Keep voluntary `memory.save/recall`: rejected because correctness would still depend on model tool motivation.
- Use an opaque idle-only best-effort pass: rejected because users cannot tell whether generation ran, failed, or was consumed.
- Require approval for every fact: rejected because approval fatigue would make memory unusable; only risky global inference waits for confirmation.
- Give each content profile a separate memory schema/store: rejected because trust, migration, deletion, and evidence would fork for every new book type.
- Move directly to SQLite or application-level encryption: deferred because the current single-user local workload can retain an inspectable atomic JSON truth source; storage interfaces must not prevent a later migration.

## Consequences

This is a boundary rewrite, not a prompt tweak. It requires schema migration, a runtime-owned write/read path, durable scheduling that does not hold the server's shared state lock across model calls, profile-aware projections, governance UI, and deterministic end-to-end contracts. Historical deterministic records migrate automatically; historical semantic profile extraction is opt-in and previewed rather than silently backfilled.
