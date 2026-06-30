# PB3 Pass2 Prompt Grill

> Status: accepted design notes for PB3 prompt/build orchestration.
> Scope: this file records the agreed Pass2 prompt and build-shape decisions. It is an implementation input, not executable code.

## 1. Core Direction

PB3 must move Pass2 away from open-ended LLM edge discovery.

```text
Pass1 merge / catalog / graph_nodes
  + PB6 profile-sidecar-batch outputs:
      - discourse_index.json
      - formula_semantics.json
  -> deterministic long_range candidate generation
  -> LLM candidate classification
  -> profile-aware deterministic gate
  -> base.json GraphEdge(scope="long_range") + pass2_audit.json
```

Pass2 must run after the profile-sidecar pass has closed. The source of `discourse_index` and `FormulaSemantics` for Pass2 is the formal sidecar files written by `profile-sidecar-batch`, not Pass1 artifacts and not ad-hoc candidate JSON passed through `pass1-batch`.

Build order:

```text
Pass1 all done -> pass1-batch writes base/source/catalog-derived artifacts
PB6 all done -> profile-sidecar-batch writes discourse_index/formula_semantics
Pass2 -> loads those sidecars for candidate generation and work packets
```
The design principle is:

```text
Comprehensiveness comes from deterministic candidate generation.
Accuracy comes from LLM classification plus deterministic gates.
The LLM must not be responsible for freely finding all long-range edges.
```

## 2. Build-Only Candidate Index

PB3 adds a build-only artifact:

```text
long_range_candidates.json
```

It is used as Pass2 prompt input and for coverage/audit debugging. It is not loaded by `Book::load`, not consumed at read time, and not a reader/runtime sidecar.

Minimal candidate shape:

```ts
interface LongRangeCandidate {
  candidate_id: string;
  source_node_id: string;
  target_node_id: string;
  source_lids: string[];
  target_lids: string[];
  seed_reasons: string[];
  relation_hints: TechnicalLearningLongRangeEdgeType[];
  seed_score: number;
}
```

## 3. Pass2 Output Classes

Pass2 prompt output must be split into:

```text
accepted_edges
pending_edges
rejected_candidates
```

Only `accepted_edges` that pass deterministic gate are lowered into `base.json.graph_edges`.
`pending_edges` and `rejected_candidates` go to `pass2_audit.json` only.

Rejected candidates are saved as full but compact records plus summary statistics:

```ts
interface RejectedCandidate {
  candidate_id: string;
  reason:
    | "topical_overlap_only"
    | "missing_source_evidence"
    | "missing_target_evidence"
    | "relation_contract_not_met"
    | "direction_unclear"
    | "weak_retrieval_value"
    | "duplicate_or_local_relation";
}
```

## 4. Edge Type Vocabulary

PB3 extends the current long-range edge type closed set with:

```text
supports
rebuts
summarizes
```

PB3 must not add:

```text
related_to
same_problem
reuses_formula
```

Formula reuse should be represented as `applies` or `builds_on` for now, with FormulaSemantics evidence mentioned in audit rationale. A dedicated `reuses_formula` relation requires a separate slice.

Target closed set:

```ts
type TechnicalLearningLongRangeEdgeType =
  | "builds_on"
  | "contradicts"
  | "exemplifies"
  | "prerequisite"
  | "refines"
  | "applies"
  | "analogous_to"
  | "contrasts"
  | "supports"
  | "rebuts"
  | "summarizes";
```

## 5. Edge Type Contracts

The prompt must not merely list enum values. Each edge type must include:

```text
1. when it holds
2. when it does not hold
3. evidence requirements
4. source/target direction rules
```

The prompt must explicitly distinguish:

```text
prerequisite vs builds_on
contrasts vs contradicts vs rebuts
exemplifies vs applies
supports vs builds_on
```

## 6. Direction

Core `GraphEdge.direction` stays:

```ts
"directed" | "undirected"
```

The semantic direction is defined by:

```text
type + source + target
```

Prompt direction policy:

```text
directed:
  prerequisite, builds_on, applies, exemplifies, refines,
  supports, rebuts, summarizes, contradicts

undirected:
  analogous_to

contrasts:
  default directed; may be undirected only for pure symmetric comparison.
```

The prompt must explain source/target roles in each edge type contract. `GraphEdge.direction` is only the coarse graph-direction flag.

## 7. Evidence Split

Accepted edges must split evidence by side:

```ts
interface TechnicalLearningAcceptedEdge {
  candidate_id: string;
  source: string;
  target: string;
  type: TechnicalLearningLongRangeEdgeType;
  direction: "directed" | "undirected";
  scope: "long_range";
  weight: number;
  source_evidence_lids: string[];
  target_evidence_lids: string[];
  evidence_lids: string[];
  support_level: "explicit" | "strong_inference";
  rationale: string;
  failure_risk?: string;
}
```

Gate requirements:

```text
source_evidence_lids non-empty
target_evidence_lids non-empty
evidence_lids covers source_evidence_lids union target_evidence_lids
all evidence LIDs exist
```

Only Core fields are written into `GraphEdge`; split evidence stays in audit.

## 8. Support Level

Pass2 uses:

```ts
type SupportLevel = "explicit" | "strong_inference" | "weak_inference";
```

Rules:

```text
explicit:
  explicit cross-reference or very clear textual signal.

strong_inference:
  no explicit cross-reference, but both sides provide strong evidence and satisfy an edge type contract.

weak_inference:
  topical similarity, term overlap, or plausible relation without enough evidence.
```

Only `explicit` and `strong_inference` can enter `accepted_edges`.
`weak_inference` must go to `pending_edges` and never be written into `base.json`.

## 9. Gate Strategy

PB3 v1 uses hard gates plus profile compatibility soft reporting.

Hard gate:

```text
source node exists
target node exists
edge type allowed
scope = long_range
source_evidence_lids non-empty
target_evidence_lids non-empty
support_level != weak_inference
weight/confidence meets threshold
source/target evidence are cross-window
```

Profile compatibility matrix is reported but not used as a hard drop in PB3 v1:

```ts
type ProfileCompatibility = "pass" | "weak" | "missing_context" | "fail";
```

The matrix can use PB2 discourse and PB1 FormulaSemantics, but early discourse quality must not hard-delete otherwise valid edges.

## 10. Work Packet Granularity

Pass2 LLM classification runs on source-window packets.

```ts
interface Pass2WorkPacket {
  packet_id: string;
  source_window: {
    index: number;
    lid_range?: string[];
    leaf_lids: string[];
    title_path: string[];
    text: Array<{ lid: string; text: string }>;
  };
  source_nodes: CandidateNodeSnapshot[];
  source_discourse: TechnicalLearningDiscourseItem[];
  source_formula_semantics: FormulaSemantics[];
  candidate_targets: LongRangeCandidate[];
  edge_type_contracts: unknown;
}
```

`source_discourse` and `source_formula_semantics` are projections from the closed PB6 sidecar files:
- `source_discourse`: items from `discourse_index.json` whose `lid` is in the source window.
- `source_formula_semantics`: items from `formula_semantics.json` whose `formula_lid` is in the source window.
Chapter is used for grouping, coverage, and audit summaries, not as the minimal LLM classification unit.

## 11. Candidate Builder V1 Signals

PB3 v1 candidate generation uses exactly these seed signal families:

```text
1. definition/explanation -> application/example/procedure_step
2. prerequisite/main_point -> concept_elaboration/worked_example
3. FormulaSemantics definition/use bridge
4. repeated graph node across distant windows
```

PB3 v1 must not implement:

```text
claim predicate similarity
graph expansion seed
title semantic matching
same_problem
```

Those are later slices if needed.

## 12. Long-Range Definition

PB3 v1 hard definition:

```text
source_evidence_lids and target_evidence_lids must cross windows.
```

If all evidence is inside one window, it is not a Pass2 long-range edge. It belongs to Pass1 local graph edges or PB2 discourse relations.

Implementation can use:

```ts
lidToWindowIndex: Map<string, number>
```

and require at least one source evidence LID and one target evidence LID to have different window indexes.

## 13. Prompt Posture

The Pass2 prompt must default to rejection:

```text
For each candidate:
1. identify source-side evidence
2. identify target-side evidence
3. check the edge type contract
4. check direction
5. look for weaker alternatives such as same topic or no edge
6. accept only if useful for future retrieval
```

It must reject mere topical overlap, unclear direction, missing side evidence, weak retrieval value, and local/duplicate relations.

## 14. PB3 Implementation Boundary

PB3 includes:

```text
long_range_candidates.json generation
Pass2 work packet shaping
Pass2 prompt update
accepted/pending/rejected output handling
profile-aware gate hard checks
pass2_audit.json writeback
base.json long_range edge writeback
```

PB3 does not include:

```text
PB4 read-time smoke
Book MCP / P7
reader.* or memory.*
new GraphNode envelope
reuses_formula as a new graph edge type
same_problem / related_to edge types
```

