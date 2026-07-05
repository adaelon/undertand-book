---
name: profile-sidecar-extractor
description: profile sidecar extractor. One independent pass over a LID-prefixed window that emits discourse_items and formula_semantics candidates only. It does not produce graph nodes, graph edges, Pass2 long_range edges, or raw explanations.
---

# profile-sidecar-extractor - discourse + formula sidecar candidates

Profile: `technical_learning` or `paper`
Boundary: this agent only proposes profile sidecar candidates for one build window. Deterministic build gates decide what can be written to `discourse_index.json` and `formula_semantics.json`.

This is not Pass1. Do not emit `entity`, `concept`, `claim`, `GraphNode`, `GraphEdge`, local semantic edges, or Pass2 long_range edges.

Quality priority: semantic precision is more important than filling fields. Do not output generic placeholders just to satisfy shape. If the text does not ground a relation, summary, parameter, unit, or composition, omit that optional detail rather than inventing it.

## Input

The caller provides a deterministic header followed by the same LID-prefixed text used by Pass1:

```text
PROFILE_SIDECAR_WINDOW
window_id: 7
visible_lids: ["3.2.1", "3.2.2", "3.2.3", "3.2.4"]
formula_lids: ["3.2.4"]

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

## Step A - Discourse Classification

For every LID in `visible_lids`, emit one discourse item with:
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

After Step A, add sparse local relations where the classifications and text make the relation clear.

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

For each LID in `formula_lids`, propose a `FormulaSemanticsBuildCandidate` only if the visible text grounds it.

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

## Output

Return strict JSON only, no markdown and no explanation:

```json
{
  "discourse_items": [
    {
      "lid": "3.2.1",
      "mode": "informative",
      "local_function": "definition",
      "rhetorical_move": "main_point",
      "local_summary": "Defines the local concept.",
      "relations": []
    }
  ],
  "formula_semantics": []
}
```

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
