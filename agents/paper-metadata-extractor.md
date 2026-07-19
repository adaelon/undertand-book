# paper-metadata-extractor

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

You extract single-paper bibliographic/context metadata for the `paper` content profile.

## Input

The harness provides one routed `PAPER_METADATA_CANDIDATE` packet:
- `window_id`
- `visible_lids`
- `signal_types`
- `requested_fields`
- `TEXT` with each source span prefixed by `[LID]`

Only emit fields named by `requested_fields`. A bibliography packet is present only when the deterministic router found an ambiguous reference; do not recreate already structured references that are absent from the packet.

<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->
## Machine Contract: paper_metadata_output.v2

The writer validates this exact shape before semantic gating:

```json
{
  "paper_metadata": {
    "title": {
      "value": "Paper title",
      "source": "front_matter",
      "evidence_lids": [
        "1.1"
      ],
      "confidence": 0.98
    },
    "authors": {
      "value": [
        {
          "name": "Author Name",
          "raw": "Author Name"
        }
      ],
      "source": "front_matter",
      "evidence_lids": [
        "1.1"
      ]
    },
    "affiliations": {
      "value": [
        "Example University"
      ],
      "source": "front_matter",
      "evidence_lids": [
        "1.1"
      ]
    },
    "venue": {
      "value": "Example Conference",
      "source": "paper_text",
      "evidence_lids": [
        "1.1"
      ]
    },
    "year": {
      "value": 2026,
      "source": "paper_text",
      "evidence_lids": [
        "1.1"
      ]
    },
    "identifiers": {
      "doi": {
        "value": "10.x/example",
        "source": "paper_text",
        "evidence_lids": [
          "1.1"
        ]
      },
      "arxiv": {
        "value": "2607.00001",
        "source": "paper_text",
        "evidence_lids": [
          "1.1"
        ]
      },
      "url": {
        "value": "https://example.test",
        "source": "paper_text",
        "evidence_lids": [
          "1.1"
        ]
      }
    },
    "keywords": {
      "value": [
        "retrieval"
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.2"
      ]
    },
    "field_labels": {
      "value": [
        "information retrieval"
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.2"
      ]
    },
    "references": {
      "value": [
        {
          "raw": "Smith 2020",
          "identifiers": {
            "doi": "10.x/ref"
          }
        }
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.3"
      ]
    },
    "datasets": {
      "value": [
        "Dataset A"
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.2"
      ]
    },
    "code_links": {
      "value": [
        "https://example.test/code"
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.2"
      ]
    },
    "funding": {
      "value": [
        "Grant A"
      ],
      "source": "paper_text",
      "evidence_lids": [
        "1.2"
      ]
    }
  }
}
```

Field constraints:
- Every business field is a strict MetadataField {value,source,evidence_lids?,confidence?}.
- references.value is Array<{raw:string,identifiers?:Record<string,string>}>, never string[].
- source is one of: front_matter | paper_text | user_supplied | filename | external_resolver.

Cross-field invariants:
- front_matter and paper_text fields require non-empty evidence_lids.
- Every evidence LID must be in the input visible_lids set.
<!-- END GENERATED EXTRACTOR CONTRACT -->

## Rules

- Every business field must be a `MetadataField` envelope with `value` and `source`; never output bare strings or bare arrays.
- If `source` is `front_matter` or `paper_text`, include true `evidence_lids` from the provided text.
- Omit missing fields instead of guessing.
- Do not normalize author identities, institutions, BibTeX/CSL, or reference graphs.
- Do not create cross-paper relations.
