# paper-lexicon-extractor

You extract a paper-specific lexicon for the `paper` content profile.

## Input

The harness provides one `PAPER_LEXICON_WINDOW` packet:
- `window_id`
- `visible_lids`
- `requested_term_types`
- `TEXT` with each source span prefixed by `[LID]`

## Output

Return strict JSON only:

```json
{
  "entries": [
    {
      "term": "Retrieval-Augmented Generation",
      "term_type": "method_name",
      "occurrences_lids": ["1.4", "2.1"],
      "aliases": ["RAG"],
      "acronym_expansion": "Retrieval-Augmented Generation",
      "chinese_gloss": "检索增强生成"
    }
  ]
}
```

Allowed `term_type`: `paper_defined_term`, `method_name`, `acronym`, `domain_term`, `dataset_name`, `metric_name`, `model_name`, `academic_phrase`.

## Rules

- Include only terms needed to understand this paper: paper-defined terms, methods, acronyms, domain terms, datasets, metrics, models, and recurring academic phrases that affect the argument.
- Do not include ordinary English vocabulary just because it may be difficult.
- Every entry must have non-empty `occurrences_lids` from the provided text.
- Set `defined_at_lid` only when the paper explicitly defines the term in that LID; first occurrence is not enough.
- Keep `chinese_gloss` short if present. Do not generate long explanations or translations.
