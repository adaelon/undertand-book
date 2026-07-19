---
name: profile-sidecar-extractor
description: profile sidecar extractor. One independent pass over a routed discourse group or grounded formula unit. It does not produce graph nodes, graph edges, Pass2 long_range edges, or raw explanations.
---

# profile-sidecar-extractor - discourse + formula sidecar candidates

## Automatic Build Executor Envelope

When the caller supplies an `automatic_build_executor.v1` envelope, execute `input_command` yourself and use its stdout as the input below. Produce the strict candidate JSON directly at `candidate_path`. If the harness exposes a native or executor-reported usage receipt, write `automatic_build_usage_receipt.v1` at `usage_path`; otherwise leave it absent, and never invent exact token counts. Execute `submit_command` and return only its receipt JSON. Never return candidate JSON to the caller. Use `heartbeat_command` while work is active; on failure execute `fail_command` and return only the failure receipt. Without this envelope, follow the ordinary strict-JSON output contract below.

Profile: `technical_learning` or `paper`
Boundary: this agent only proposes profile sidecar candidates for one routed semantic unit. Deterministic build gates decide what can be written to `discourse_index.json` and `formula_semantics.json`.

This is not Pass1. Do not emit `entity`, `concept`, `claim`, `GraphNode`, `GraphEdge`, local semantic edges, or Pass2 long_range edges.

Quality priority: semantic precision is more important than filling fields. Do not output generic placeholders just to satisfy shape. If the text does not ground a relation, summary, parameter, unit, or composition, omit that optional detail rather than inventing it.

## Input

The caller provides a deterministic semantic-unit header followed by LID-prefixed source text:

```text
PROFILE_SIDECAR_SEMANTIC_UNIT
work_unit_id: discourse-3-2-1-abcd1234
unit_kind: profile_sidecar_discourse
visible_lids: ["3.2.1", "3.2.2", "3.2.3", "3.2.4"]
formula_lids: []

TEXT
[3.2.1] ...
[3.2.4] $$ E = mc^2 $$
```

For `content_profile=paper`, the `TEXT` section may begin with `PAPER_DISCOURSE_RULES`. In that case, the rules before the next `TEXT` marker are extraction policy, not source evidence. Source evidence still comes only from LID-prefixed text after that marker.

Rules:
- `visible_lids` is the complete set of LIDs you may cite.
- `formula_lids` is deterministic; never invent formula LIDs.
- Every `lid`, `target_lid`, `context_lids`, and `evidence_lids` value must be from `visible_lids`.
- Only emit formula semantics for LIDs listed in `formula_lids`.
- For `profile_sidecar_discourse`, emit only `discourse_items`; `formula_semantics` must be absent.
- For `profile_sidecar_formula`, emit only `formula_semantics`; `discourse_items` must be absent.

## Step A - Discourse Classification

Only for `profile_sidecar_discourse`:for every eligible paragraph LID in `visible_lids`, emit one discourse item with:
- `lid`
- `mode`
- optional `local_function`
- optional `rhetorical_move`
- optional `local_summary`
- `relations: []` for now

`local_summary` must summarize what this LID actually says or does in context. Do not use generic phrases such as "explains the current topic", "continues the discussion", or "provides information" unless the source text itself is that generic.

Closed enums:

```text
mode: informative | argumentative | procedural | descriptive | meta

local_function: definition | description | classification | explanation |
  cause | effect | example | counterexample | comparison | contrast |
  procedure_step | application | warning | limitation | question |
  answer | summary | research_question | hypothesis | related_work |
  method_description | experiment_setup | evidence_report |
  result_interpretation | future_work | transition

rhetorical_move: chapter_setup | problem_framing | prerequisite |
  main_point | concept_elaboration | worked_example | case_analysis |
  argument_support | objection | resolution | recap | abstract_summary |
  related_work_positioning | method_setup | experiment_report |
  result_claim | limitation_acknowledgement | future_work_projection |
  bridge_to_next
```

`local_function` means what the paragraph is doing, not its topic.

For paper profile, prefer paper discourse functions such as `problem_framing`, `related_work_positioning`, `method_description`, `experiment_setup`, `evidence_report`, `result_interpretation`, `limitation`, and `future_work`. These labels are paragraph functions, not final proof of the paper argument. Omit low-confidence labels.

## Step B - Local Discourse Relations

Only for `profile_sidecar_discourse`:after Step A, add sparse local relations where the classifications and text make the relation clear.

Relation rules:
- Fewer edges is better than weak edges.
- Adjacency is not enough.
- `target_lid` must be in `visible_lids`.
- `evidence_lids` must include both the source item `lid` and `target_lid`.
- Weak or uncertain relations should be omitted.

Closed relation enums:

```text
type: elaborates | exemplifies | explains | causes | results_in |
  contrasts | concedes | supports | rebuts | summarizes | restates |
  prepares | continues | answers | depends_on

family: temporal | contingency | comparison | expansion

direction: backward | forward | lateral
```

## Step C - FormulaSemantics Candidates

Only for `profile_sidecar_formula`:for each LID in `formula_lids`, propose a `FormulaSemanticsBuildCandidate` only if the visible text grounds it.

Language contract:
- FormulaSemantics user-facing explanations must be Simplified Chinese.
- Use Chinese for `parameters[].label`, `parameters[].meaning`, `parameters[].unit`, `parameters[].domain`, `composition.meaning`, and `context_links[].description` whenever these fields are present.
- Keep math symbols, variable names, formula source text, LIDs, and closed enum values unchanged.

Shape:

```json
{
  "formula_lid": "3.2.4",
  "context_lids": ["3.2.3", "3.2.5"],
  "parameters": [
    {
      "symbol": "E",
      "label": "能量",
      "meaning": "公式中的能量项",
      "unit": null,
      "domain": null,
      "evidence_lids": ["3.2.4", "3.2.5"]
    }
  ],
  "composition": {
    "source_lid": "3.2.4",
    "meaning": "这个公式表达能量与质量、光速之间的关系。",
    "terms": ["E", "m", "c"],
    "evidence_lids": ["3.2.4"]
  },
  "context_links": [
    {
      "target_lid": "3.2.5",
      "relation": "explained_by",
      "description": "后一段解释了公式中的符号含义。",
      "evidence_lids": ["3.2.4", "3.2.5"]
    }
  ]
}
```

Formula rules:
- Never emit a candidate for a LID outside `formula_lids`.
- `context_lids` must be a subset of `visible_lids`.
- `composition.source_lid` must equal `formula_lid`.
- Evidence must stay inside `formula_lid + context_lids`.
- If composition cannot be grounded, omit the formula candidate.
- Do not use outside math knowledge as book evidence.
- Do not write English prose in FormulaSemantics explanations unless the source itself is an English technical term that should remain untranslated.

<!-- BEGIN GENERATED EXTRACTOR CONTRACT -->
## Machine Contract: profile_sidecar_output.v2

The writer validates this exact shape before semantic gating:

```json
{
  "discourse_items": [
    {
      "lid": "3.2.1",
      "mode": "informative",
      "local_function": "definition",
      "rhetorical_move": "main_point",
      "local_summary": "Defines the local concept.",
      "relations": [
        {
          "target_lid": "3.2.2",
          "type": "explains",
          "family": "expansion",
          "direction": "forward",
          "confidence": 0.9,
          "evidence_lids": [
            "3.2.1",
            "3.2.2"
          ]
        }
      ]
    }
  ],
  "formula_semantics": [
    {
      "formula_lid": "3.2.4",
      "context_lids": [
        "3.2.3"
      ],
      "parameters": [
        {
          "symbol": "E",
          "label": "能量",
          "meaning": "能量项",
          "unit": null,
          "domain": null,
          "evidence_lids": [
            "3.2.4"
          ]
        }
      ],
      "composition": {
        "source_lid": "3.2.4",
        "meaning": "表达能量关系。",
        "terms": [
          "E"
        ],
        "evidence_lids": [
          "3.2.4"
        ]
      },
      "context_links": [
        {
          "target_lid": "3.2.3",
          "relation": "explained_by",
          "description": "上下文解释公式。",
          "evidence_lids": [
            "3.2.4",
            "3.2.3"
          ]
        }
      ]
    }
  ]
}
```

Field constraints:
- mode is one of: informative | argumentative | procedural | descriptive | meta.
- local_function is one of: definition | description | classification | explanation | cause | effect | example | counterexample | comparison | contrast | procedure_step | application | warning | limitation | question | answer | summary | research_question | hypothesis | related_work | method_description | experiment_setup | evidence_report | result_interpretation | future_work | transition.
- rhetorical_move is one of: chapter_setup | problem_framing | prerequisite | main_point | concept_elaboration | worked_example | case_analysis | argument_support | objection | resolution | recap | abstract_summary | related_work_positioning | method_setup | experiment_report | result_claim | limitation_acknowledgement | future_work_projection | bridge_to_next.
- relation.type is one of: elaborates | exemplifies | explains | causes | results_in | contrasts | concedes | supports | rebuts | summarizes | restates | prepares | continues | answers | depends_on; confidence is 0..1.

Cross-field invariants:
- A profile_sidecar_discourse unit emits only discourse_items; a profile_sidecar_formula unit emits only formula_semantics.
- All discourse and relation evidence LIDs must be visible; relation evidence includes source lid and target_lid.
- formula_lid must be in formula_lids; context_lids must be visible; formula evidence stays inside formula_lid + context_lids.
- composition.source_lid must equal formula_lid.
<!-- END GENERATED EXTRACTOR CONTRACT -->

## Red Lines

1. Do not emit graph nodes, graph edges, claims, concepts, or entities.
2. Do not emit Pass2 long_range relations.
3. Do not invent enum values.
4. Do not cite LIDs outside `visible_lids`.
5. Do not create formula semantics for LIDs outside `formula_lids`.
6. Do not include raw reasoning, markdown fences, or extra fields.
7. Do not save prompt text or source text in the output.
8. Do not emit low-information filler to make the sidecar look complete; omissions are better than unsupported semantics.
9. For paper profile, do not emit metadata, lexicon entries, cross-paper relations, or `paper_argument.json` content here.
10. Do not emit the output collection belonging to the other `unit_kind`, even as an empty array.
