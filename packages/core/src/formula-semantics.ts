// FormulaSemantics candidate gate [ADR-0029 / SA5].
// LLM may propose parameters/composition/context links; this module decides what can enter read-only semantics.
import type { FormulaComposition } from "./generated/FormulaComposition";
import type { FormulaContextLink } from "./generated/FormulaContextLink";
import type { FormulaParameter } from "./generated/FormulaParameter";
import type { FormulaSemantics } from "./generated/FormulaSemantics";
import type { LidNode } from "./generated/LidNode";

export type FormulaPendingKind = "parameter" | "composition" | "context_link";

export interface FormulaPendingItem {
  kind: FormulaPendingKind;
  index: number;
  reason: string;
  item: unknown;
}

export interface FormulaSemanticsCandidate {
  formula_lid: string;
  parameters?: FormulaParameter[];
  composition?: FormulaComposition;
  context_links?: FormulaContextLink[];
}

export interface FormulaSemanticsGateOptions {
  /** LIDs visible to the extractor around the formula. Must include any valid contextual evidence. */
  contextLids?: Iterable<string>;
}

export interface FormulaSemanticsGateResult {
  semantics: FormulaSemantics | null;
  pending: FormulaPendingItem[];
}

function lidSet(nodes: LidNode[]): Set<string> {
  return new Set(nodes.map((n) => n.lid));
}

function formulaExists(formulaLid: string, nodes: LidNode[]): boolean {
  return nodes.some((n) => n.lid === formulaLid && n.kind === "formula");
}

function allowedEvidenceSet(formulaLid: string, nodes: LidNode[], contextLids?: Iterable<string>): Set<string> {
  const all = lidSet(nodes);
  const allowed = new Set<string>([formulaLid]);
  if (contextLids) {
    for (const lid of contextLids) {
      if (all.has(lid)) allowed.add(lid);
    }
  }
  return allowed;
}

function evidenceError(evidenceLids: string[], allLids: Set<string>, allowedLids: Set<string>, requireNonEmpty: boolean): string | null {
  if (requireNonEmpty && evidenceLids.length === 0) return "missing evidence_lids";
  const dangling = evidenceLids.filter((lid) => !allLids.has(lid));
  if (dangling.length) return `dangling evidence_lids: ${dangling.join(",")}`;
  const outOfContext = evidenceLids.filter((lid) => !allowedLids.has(lid));
  if (outOfContext.length) return `evidence_lids outside formula context: ${outOfContext.join(",")}`;
  return null;
}

export function gateFormulaSemanticsCandidate(
  candidate: FormulaSemanticsCandidate,
  nodes: LidNode[],
  options: FormulaSemanticsGateOptions = {},
): FormulaSemanticsGateResult {
  const allLids = lidSet(nodes);
  const pending: FormulaPendingItem[] = [];
  if (!formulaExists(candidate.formula_lid, nodes)) {
    return {
      semantics: null,
      pending: [
        {
          kind: "composition",
          index: 0,
          reason: `formula_lid is not a formula node: ${candidate.formula_lid}`,
          item: candidate,
        },
      ],
    };
  }

  const allowedLids = allowedEvidenceSet(candidate.formula_lid, nodes, options.contextLids);

  const parameters: FormulaParameter[] = [];
  for (const [index, p] of (candidate.parameters ?? []).entries()) {
    const reason = evidenceError(p.evidence_lids, allLids, allowedLids, true);
    if (reason) pending.push({ kind: "parameter", index, reason, item: p });
    else parameters.push(p);
  }

  let composition: FormulaComposition | null = null;
  if (!candidate.composition) {
    pending.push({ kind: "composition", index: 0, reason: "missing composition", item: candidate });
  } else if (candidate.composition.source_lid !== candidate.formula_lid) {
    pending.push({ kind: "composition", index: 0, reason: "composition source_lid must equal formula_lid", item: candidate.composition });
  } else {
    const reason = evidenceError(candidate.composition.evidence_lids, allLids, allowedLids, false);
    if (reason) pending.push({ kind: "composition", index: 0, reason, item: candidate.composition });
    else composition = candidate.composition;
  }

  const context_links: FormulaContextLink[] = [];
  for (const [index, link] of (candidate.context_links ?? []).entries()) {
    if (!allLids.has(link.target_lid)) {
      pending.push({ kind: "context_link", index, reason: `target_lid does not exist: ${link.target_lid}`, item: link });
      continue;
    }
    if (!allowedLids.has(link.target_lid)) {
      pending.push({ kind: "context_link", index, reason: `target_lid outside formula context: ${link.target_lid}`, item: link });
      continue;
    }
    const reason = evidenceError(link.evidence_lids, allLids, allowedLids, true);
    if (reason) pending.push({ kind: "context_link", index, reason, item: link });
    else context_links.push(link);
  }

  if (!composition) return { semantics: null, pending };
  return {
    semantics: {
      formula_lid: candidate.formula_lid,
      parameters,
      composition,
      context_links,
    },
    pending,
  };
}

export function formatFormulaSemanticsForPrompt(semantics: FormulaSemantics): string {
  const lines = [`Formula ${semantics.formula_lid}`];
  lines.push(`Composition: ${semantics.composition.meaning}`);
  if (semantics.composition.terms.length) lines.push(`Terms: ${semantics.composition.terms.join("; ")}`);
  if (semantics.parameters.length) {
    lines.push("Parameters:");
    for (const p of semantics.parameters) {
      const label = p.label ? `${p.symbol} (${p.label})` : p.symbol;
      const unit = p.unit ? ` unit=${p.unit}` : "";
      const domain = p.domain ? ` domain=${p.domain}` : "";
      lines.push(`- ${label}: ${p.meaning}${unit}${domain} [${p.evidence_lids.join(", ")}]`);
    }
  }
  if (semantics.context_links.length) {
    lines.push("Context links:");
    for (const link of semantics.context_links) {
      lines.push(`- ${link.relation} ${link.target_lid}: ${link.description} [${link.evidence_lids.join(", ")}]`);
    }
  }
  return lines.join("\n");
}
