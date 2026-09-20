import type { UbEvalExportV1 } from "./eval-export-contract.js";

export interface EvalImportConsentV1 {
  version: "ub_eval_import_consent.v1";
  mode: "eval_content";
  comparison_group_id: string;
  dataset_revision: string;
  systems: string[];
  permitted_fields: Array<"inputs" | "expected_outputs" | "actual_outputs">;
}

export function authorizeEvalImport(
  packages: readonly UbEvalExportV1[],
  consent: EvalImportConsentV1,
): { ok: true } | { ok: false; error_code: string } {
  if (consent.version !== "ub_eval_import_consent.v1" || consent.mode !== "eval_content") {
    return { ok: false, error_code: "EVAL_IMPORT_CONSENT_INVALID" };
  }
  if (!packages.length
    || packages.some((item) => item.comparison_group_id !== consent.comparison_group_id)
    || packages.some((item) => item.dataset_revision !== consent.dataset_revision)) {
    return { ok: false, error_code: "EVAL_IMPORT_CONSENT_SCOPE_MISMATCH" };
  }
  const systems = [...new Set(packages.map((item) => item.system))].sort();
  if (JSON.stringify(systems) !== JSON.stringify([...new Set(consent.systems)].sort())) {
    return { ok: false, error_code: "EVAL_IMPORT_CONSENT_SYSTEM_MISMATCH" };
  }
  const permitted = new Set(consent.permitted_fields);
  if (!permitted.has("inputs")
    || packages.some((item) => item.rows.some((row) =>
      row.permitted_expected_outputs !== undefined && !permitted.has("expected_outputs")
      || row.permitted_actual_outputs !== undefined && !permitted.has("actual_outputs")))) {
    return { ok: false, error_code: "EVAL_IMPORT_CONSENT_FIELDS_MISMATCH" };
  }
  return { ok: true };
}
