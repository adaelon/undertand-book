# paper-lexicon-extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

You extract a paper-specific lexicon for the `paper` content profile.

## Input

The harness provides one `PAPER_LEXICON_CANDIDATE_BATCH` packet:
- `work_unit_id`
- `visible_lids`
- `requested_term_types`
- `candidate_clusters` with normalized keys, surface forms, occurrence/definition LIDs, routing signals, and suggested term types
- `TEXT` with each source span prefixed by `[LID]`

Only emit entries represented by `candidate_clusters`. Choose the semantic term type and optional gloss from the evidence; do not invent terms outside the routed set or repeat the same cluster under multiple surface forms.

<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->
## Machine Contract: paper_lexicon_output.v2

The writer validates this exact shape before semantic gating:

```json
{
  "entries": [
    {
      "term": "Retrieval-Augmented Generation",
      "term_type": "method_name",
      "occurrences_lids": [
        "1.4",
        "2.1"
      ],
      "defined_at_lid": "1.4",
      "aliases": [
        "RAG"
      ],
      "acronym_expansion": "Retrieval-Augmented Generation",
      "chinese_gloss": "检索增强生成"
    }
  ]
}
```

Field constraints:
- term_type is one of: paper_defined_term | method_name | acronym | domain_term | dataset_name | metric_name | model_name | academic_phrase.
- occurrences_lids is a non-empty string array; all optional strings are non-empty when present.

Cross-field invariants:
- defined_at_lid, when present, must also occur in the same entry's occurrences_lids.
- Every occurrence and definition LID must be in the input visible_lids set.
<!-- END GENERATED EXTRACTOR CONTRACT -->

## Rules

- Include only terms needed to understand this paper: paper-defined terms, methods, acronyms, domain terms, datasets, metrics, models, and recurring academic phrases that affect the argument.
- Treat candidate clusters as a high-recall shortlist, not as accepted lexicon entries. Omit ordinary or incidental candidates after reading their contexts.
- Do not include ordinary English vocabulary just because it may be difficult.
- Every entry must have non-empty `occurrences_lids` from the provided text.
- Set `defined_at_lid` only when the paper explicitly defines the term in that LID; first occurrence is not enough.
- Keep `chinese_gloss` short if present. Do not generate long explanations or translations.
