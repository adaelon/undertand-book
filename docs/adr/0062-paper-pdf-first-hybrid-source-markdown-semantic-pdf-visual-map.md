# ADR-0062 Paper PDF-first hybrid source
Status: Superseded by ADR-0063 for source truth and build workflow, 2026-07-09.
Revises: ADR-0046.

## Superseded Note
ADR-0062 remains useful for the clean-room PDF boundary, LID-as-anchor rule, and PDF-first reader goal. Its core source-truth assumption is superseded: `source.txt` is no longer raw Markdown for PDF-first paper builds; ADR-0063 makes `source.txt` the reconciled canonical output of PDF+Markdown source reconciliation.

## Context
ADR-0046 kept paper MVP anchored on cleaned Markdown and treated the original PDF as an optional sidecar. That protected the LID/source/book.text model, but it leaves the main reading surface unlike how paper readers actually work. Paper users need page-faithful PDF reading, while the agent and citation gate still need stable LID evidence.

Zotero document-worker was reviewed as a reference architecture. It cleanly separates document processing from UI and uses PDF text extraction, page geometry, structured text, and render-area operations. Its implementation is AGPL-3.0 and depends on Zotero-specific pdf.js fork paths, structured-document-text, wasm assets, and ONNX models. We will not use, copy, bundle, link, or distribute that code or those assets.

## Historical Decision
Paper profile v1 uses Markdown as the semantic source and the original PDF as the visual reading surface, connected by word-level `pdf_source_map`.

The implementation will be clean-room:

```text
paper.md
  -> markdownToBlocks()
  -> source.txt
  -> segment(SourceBlock[])
  -> base.json

paper.pdf
  -> Mozilla pdf.js word extraction
  -> pageIndex + word bbox stream

alignment
  -> deterministic fuzzy match Markdown spans to PDF words
  -> pdf_source_map.json
  -> alignment_report.json
```

The reader is PDF-first for `paper` profile. LID remains the only citation and memory anchor; page and bbox data only project a LID back onto the PDF.

## Zotero Reference Boundary
Allowed as architectural reference:
- Worker/build-time extractor boundary.
- Separation of PDF text extraction, page geometry, structured text, and render-area concerns.
- `pageIndex + bbox/rects` as visual provenance.
- Pipeline shape: PDF source -> structured blocks -> source map -> reader projection.

Forbidden:
- Copying Zotero document-worker source code, tests, fixtures, model files, or build scripts.
- Using Zotero's pdf.js fork private paths or structured-document-text package.
- Shipping Zotero document-worker, its worker bundle, wasm/model assets, or derived code in the default product.
- Accepting LLM claims about page/bbox mapping without deterministic alignment verification.

## Historical Rules
1. Input v1 requires explicit `paper.md + paper.pdf`; no built-in PDF-to-Markdown or OCR.
2. `source.txt` is the original Markdown text; `SourceBlock.span` remains Markdown UTF-16 offsets.
3. PDF words and bboxes are extracted with a permissively licensed implementation such as Mozilla `pdfjs-dist`.
4. Alignment is deterministic by default. Optional LLM repair may propose repaired block text, but deterministic alignment thresholds decide acceptance.
5. Per-LID mapping quality:
   - `confidence >= 0.85`: word-level map.
   - `0.65 <= confidence < 0.85`: line/block fallback plus warning.
   - `confidence < 0.65`: no PDF map for that LID plus warning.
6. Whole build fails if mapped leaf LID ratio is below `0.80`.
7. Page furniture is excluded from semantic source and recorded in the report.
8. User highlights and notes remain anchored to LID; optional PDF region snapshots are display/debug metadata only.

## Rejected
- PDF-only semantic source: PDF layout extraction is too unstable for citation truth in v1.
- Markdown-only reader: paper users need page-faithful reading.
- Zotero document-worker integration: AGPL and dependency surface are too costly for default product distribution.
- `page:bbox` as citation anchor: it bypasses existing LID gates and memory semantics.
- LLM-as-judge for alignment: correctness must come from deterministic matching and thresholds.

## Consequences
- ADR-0046 remains historical context but is superseded for paper reading UX by this hybrid source model.
- `pdf_source_map.json` becomes required for PDF-first paper reader quality, but LID remains the only evidence anchor.
- The PDF viewer must be controlled by our app, using pdf.js rendering and overlay regions rather than browser `<iframe>`/`embed`.
- The first implementation should be narrow: born-digital English academic papers, no OCR, no table/formula structure understanding.

## Revisit When
- A permissively licensed PDF-to-structured extractor can replace Markdown as semantic source with equal or better alignment confidence.
- OCR support is required for scanned PDFs.
- Table/formula/image structure becomes necessary for paper agent answers rather than visual-only reading.
