import type {
  ProfileGovernanceActionRequest,
  ProfileMemoryState,
  ProfileMemoryUpdate,
} from "./api";

export type ProfileFact = ProfileMemoryState["facts"][number];
export type ProfileEvidence = ProfileMemoryState["evidence"][number];
export type ProfileScopeTab = "book" | "global";

export function isActiveProfileFact(fact: ProfileFact): boolean {
  return fact.status === "confirmed" || fact.status === "provisional";
}

export function factsForScope(
  state: ProfileMemoryState | null | undefined,
  scope: ProfileScopeTab,
  includeHistory = false,
): ProfileFact[] {
  return (state?.facts ?? [])
    .filter((fact) => fact.scope_kind === scope)
    .filter((fact) => includeHistory || isActiveProfileFact(fact))
    .sort((left, right) => left.payload_key.localeCompare(right.payload_key)
      || left.fact_id.localeCompare(right.fact_id));
}

export function evidenceForFact(
  state: ProfileMemoryState | null | undefined,
  factId: string,
): ProfileEvidence[] {
  return (state?.evidence ?? [])
    .filter((evidence) => evidence.fact_id === factId)
    .sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
}

export function factSemanticKey(fact: ProfileFact): string {
  return `${fact.payload_kind}:${fact.payload_key}`;
}

export function buildUndoProfileAction(
  state: ProfileMemoryState | null | undefined,
  update: ProfileMemoryUpdate,
  operationId: string,
): ProfileGovernanceActionRequest | null {
  const factId = update.fact_ids[0];
  if (!state || !factId) return null;
  const current = state.facts.find((fact) => fact.fact_id === factId);
  if (!current || !isActiveProfileFact(current)) return null;

  if (update.kind === "remembered") {
    return {
      kind: "forget",
      operation_id: operationId,
      fact_id: current.fact_id,
    };
  }

  if (update.kind !== "corrected") return null;
  const previousId = current.supersedes[0];
  const previous = state.facts.find((fact) => fact.fact_id === previousId);
  if (!previous) return null;
  return {
    kind: "correct",
    operation_id: operationId,
    evidence_text: `User undid profile correction ${current.fact_id}`,
    fact_id: current.fact_id,
    payload_value: previous.payload_value,
    valid_until: previous.valid_until,
  };
}
