# ADR-0063 Paper PDF-first reconciled source and Build Workbench
Status: Accepted, 2026-07-09.
Revises: ADR-0062.

ADR-0062 kept Markdown as semantic truth and used PDF only as a visual surface. Grill review found that this would freeze Markdown conversion/OCR mistakes into LID spans, highlights, notes, and citations. Paper PDF-first builds now treat `paper.md + paper.pdf` as inputs to source reconciliation; trusted `source.txt` is produced only after deterministic gates accept the reconciled text.

## Decision
For paper PDF-first builds, `source.txt` is the reconciled canonical source, not raw `paper.md`. LIDs, `book.text`, highlights, notes, citations, paper sidecars, and PDF maps are all derived from that reconciled `source.txt`.

```text
paper.md + paper.pdf
  -> source_reconciliation
  -> source.txt
  -> segment(SourceBlock[])
  -> base.json
  -> source_manifest.v2
  -> pdf_source_map.json
  -> pdf_selection_map/*
  -> alignment_report.json
```

Unresolved reconciliation is a hard stop for trusted reader artifacts. The build may write `.build/source-reconciliation/report.json`, `review-draft.md`, and `review-decisions.json`, but it must not write trusted `.understand-book/<book_id>/source.txt` or `base.json` until deterministic gates pass.

## Rules
1. `paper.md` is a draft input. It is never the final semantic truth for PDF-first paper builds.
2. `paper.pdf` is the visual verification source and reader surface, but `page:bbox` is never a citation or memory anchor.
3. `source_reconciliation` may auto-repair layout/encoding issues only: whitespace, line wrapping, deterministic hyphen unwrap, Unicode normalization, and repeated page furniture exclusion.
4. Content-bearing conflicts become `needs_review`, `pdf_unmatched`, or `md_unmatched`: changed words, numbers, units, identifiers, formulas, DOI/URL/code, missing paragraphs, table/formula linearization ambiguity, or title hierarchy conflicts.
5. Optional LLM review is format-only. A candidate may enter `source.txt` only after deterministic `content_equivalence` and PDF realignment gates pass.
6. `source_manifest.v2` is the book capability manifest. It exposes PDF viewing, LID-to-PDF projection, PDF selection resolving, range projection, freshness hashes, artifact paths, and degraded/error reasons.
7. `pdf_source_map.json` is a lightweight public runtime map for overlay, hit-test, and LID jump. Heavy provenance, rejected matches, repair candidates, and diagnostics live in `alignment_report.json`.
8. `pdf_selection_map` is backend-only, char-level, and sharded by page. `/reader/pdf_selection.resolve` and `/reader/pdf_ranges.project` derive semantic `LID/range` results from it.
9. Build Workbench is a separate build-mode surface for untrusted, incomplete, or review-required source inputs. The normal reader only opens trusted `source.txt/base.json`.
10. `.understand-book/<book_id>/.build/<stage>/` remains accepted stage truth. `.build/jobs/<job_id>/` records orchestration logs, active executor state, token/cost telemetry, and user events.
11. Build-direction choices use `BuildDecisionRequest`; executor tool permission uses `ExecutorPermissionRequest`. Build-affecting decisions are recorded both as job events and stage decision artifacts.

## Rejected
- Raw Markdown as final source truth: it preserves PDF conversion errors as permanent LID/range evidence.
- PDF-only semantic truth: born-digital extraction is not reliable enough to replace LID/source gates in v1.
- Browser PDF text as quote truth: browser/pdf.js selection text is display data; backend reconciliation maps decide quotes and ranges.
- Job state as build truth: orchestration snapshots cannot replace deterministic artifact/hash/schema recomputation.

## Consequences
- ADR-0062 and the old PDF-first slice plan must be read as historical; implementation should follow this ADR and the v2 slice plan.
- Existing Markdown-only paper builds remain valid for non-PDF-first mode, but PDF-first builds require source reconciliation before trusted reader entry.
- Paper metadata, lexicon, discourse, Pass2, BookStructure, and PaperReadingGuide run after trusted `source.txt/base.json` exist; they do not participate in deciding source truth.
- The first implementation should prove the source reconciliation and map foundation before adding polished PDF reader features.

## Revisit When
- A permissively licensed PDF-to-structured extractor can produce better canonical text than `paper.md + paper.pdf` reconciliation.
- Scanned/OCR PDFs become a required input class.
- Table, formula, or figure structure must become semantic evidence instead of visual-only context.
