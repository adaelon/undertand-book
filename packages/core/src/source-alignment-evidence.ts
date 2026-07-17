import { createHash } from "node:crypto";
import { z } from "zod";

const SourceSpanZ = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
}).refine((span) => span.end >= span.start, "source span end must not precede start");

const PdfLineSpanZ = z.object({
  pageIndex: z.number().int().nonnegative(),
  start_line_index: z.number().int().nonnegative(),
  end_line_index: z.number().int().nonnegative(),
}).refine((span) => span.end_line_index >= span.start_line_index, "PDF line span end must not precede start");

export const HybridAlignmentInputFingerprintZ = z.object({
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  pdf_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  reconciliation_config_hash: z.string().regex(/^[a-f0-9]{64}$/u),
  evidence_policy_version: z.literal("source_alignment_evidence_policy.v1"),
});

export type HybridAlignmentInputFingerprint = z.infer<typeof HybridAlignmentInputFingerprintZ>;

export const AlignmentUnitEvidenceZ = z.object({
  unit_id: z.string().min(1),
  source_span: SourceSpanZ,
  pdf_line_spans: z.array(PdfLineSpanZ),
  status: z.enum(["verified", "format_equivalent", "reviewed_hint", "unmapped"]),
});

export type AlignmentUnitEvidence = z.infer<typeof AlignmentUnitEvidenceZ>;

export const SourceAlignmentEvidenceV1Z = z.object({
  version: z.literal("source_alignment_evidence.v1"),
  book_id: z.string().min(1),
  input_fingerprint: HybridAlignmentInputFingerprintZ,
  units: z.array(AlignmentUnitEvidenceZ),
}).superRefine((evidence, context) => {
  const unitIds = new Set<string>();
  let previousEnd = 0;
  for (let index = 0; index < evidence.units.length; index += 1) {
    const unit = evidence.units[index];
    if (unitIds.has(unit.unit_id)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "unit_id"], message: "duplicate unit_id" });
    }
    unitIds.add(unit.unit_id);
    if (unit.source_span.start < previousEnd) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["units", index, "source_span"], message: "source spans must be ordered and non-overlapping" });
    }
    previousEnd = unit.source_span.end;
  }
});

export type SourceAlignmentEvidenceV1 = z.infer<typeof SourceAlignmentEvidenceV1Z>;

export function sourceAlignmentConfigHash(config: unknown): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function sourceAlignmentEvidenceFingerprint(
  source: string,
  pdfSha256: string,
  reconciliationConfigHash: string,
): HybridAlignmentInputFingerprint {
  const normalizedPdfSha256 = /^[a-f0-9]{64}$/iu.test(pdfSha256)
    ? pdfSha256.toLowerCase()
    : createHash("sha256").update(pdfSha256).digest("hex");
  return HybridAlignmentInputFingerprintZ.parse({
    source_sha256: createHash("sha256").update(source).digest("hex"),
    pdf_sha256: normalizedPdfSha256,
    reconciliation_config_hash: reconciliationConfigHash,
    evidence_policy_version: "source_alignment_evidence_policy.v1",
  });
}

export function acceptSourceAlignmentEvidence(
  value: unknown,
  expectedFingerprint: HybridAlignmentInputFingerprint,
): SourceAlignmentEvidenceV1 | null {
  const evidence = SourceAlignmentEvidenceV1Z.parse(value);
  const actual = evidence.input_fingerprint;
  return actual.source_sha256 === expectedFingerprint.source_sha256
    && actual.pdf_sha256 === expectedFingerprint.pdf_sha256
    && actual.reconciliation_config_hash === expectedFingerprint.reconciliation_config_hash
    && actual.evidence_policy_version === expectedFingerprint.evidence_policy_version
    ? evidence
    : null;
}
