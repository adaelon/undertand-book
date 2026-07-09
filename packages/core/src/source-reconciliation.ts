export type SourceBlockReconcileStatus =
  | "verified"
  | "auto_repaired"
  | "llm_format_repaired"
  | "needs_review"
  | "pdf_unmatched"
  | "md_unmatched";

export interface BuildInputFingerprint {
  paper_md_sha256: string;
  paper_pdf_sha256: string;
  config_hash: string;
}

export interface SourceReconciliationIssue {
  id: string;
  status: SourceBlockReconcileStatus;
  reason: string;
}

export interface SourceReconciliationReport {
  version: "source_reconciliation_report.v1";
  book_id: string;
  input_fingerprint: BuildInputFingerprint;
  summary: Record<SourceBlockReconcileStatus, number>;
  unresolved: SourceReconciliationIssue[];
}

export function emptyReconciliationSummary(): Record<SourceBlockReconcileStatus, number> {
  return {
    verified: 0,
    auto_repaired: 0,
    llm_format_repaired: 0,
    needs_review: 0,
    pdf_unmatched: 0,
    md_unmatched: 0,
  };
}

export function sourceReconciliationTrusted(report: SourceReconciliationReport): boolean {
  return report.unresolved.length === 0;
}
