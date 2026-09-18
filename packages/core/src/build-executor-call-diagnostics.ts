import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { validateAutomaticBuildOpenCallCorrection, type AutomaticBuildOpenCallCorrectionV1 } from "./automatic-build-executor-session";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const HANDOFF = /^abhandoff1_[a-f0-9]{64}$/u;
const OPERATIONS = new Set(["executor.open", "executor.input.next", "executor.generation.start", "executor.submit_candidate"]);
const CODES = new Set(["invalid_arguments", "protocol_incompatible", "handoff_ref_mismatch", "connection_terminal", "executor_internal"]);
function object(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Stream the owned rollout locally. Only whitelisted control facts leave this function. */
export async function readOwnedExecutorOpenDiagnostic(
  file: string, parentId: string, childId: string, issuedRef: string,
) {
  if (!UUID.test(parentId) || !UUID.test(childId) || !HANDOFF.test(issuedRef)) {
    throw new Error("invalid child diagnostic identity");
  }
  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let owned = false;
  let bound = false;
  let terminal = false;
  let failed: Record<string, unknown> | undefined;
  let correction: AutomaticBuildOpenCallCorrectionV1 | undefined;
  const operations: string[] = [];
  let ordinal = 0;
  try {
    for await (const line of lines) {
      let row: any;
      try { row = JSON.parse(line); } catch { continue; } // An active rollout may end with a partial line.
      if (row.type === "session_meta") {
        const meta = row.payload;
        if (meta?.id !== childId || meta?.parent_thread_id !== parentId) {
          throw new Error("child diagnostic ownership mismatch");
        }
        owned = true;
        continue;
      }
      if (!owned || row.type !== "event_msg" || row.payload?.type !== "item_completed"
        || row.payload.thread_id !== childId) continue;
      const item = row.payload.item;
      if (item?.type !== "McpToolCall" || item.server !== "understand_book_build_executor"
        || !OPERATIONS.has(item.tool)) continue;
      ordinal++;
      operations.push(item.tool);
      if (operations.length > 16) operations.shift();
      let response: any;
      try {
        const text = item.result?.content?.find((entry: any) => entry.type === "text")?.text;
        response = JSON.parse(text);
      } catch { continue; }
      if (item.tool === "executor.open" && response?.version === "automatic_build_executor_session.v3") bound = true;
      if (item.tool === "executor.open" && response?.version === "automatic_build_executor_mcp_error.v2") {
        if (response.diagnostic_code === "connection_terminal") terminal = true;
        else if (HANDOFF.test(item.arguments?.opaque_handoff_ref ?? "")
          && !["invalid_arguments", "protocol_incompatible"].includes(response.diagnostic_code)) bound = true;
      }
      if (response?.action?.kind === "DONE") terminal = true;
      if (item.tool !== "executor.open" || response?.version !== "automatic_build_executor_mcp_error.v2"
        || response.phase !== "open" || !CODES.has(response.diagnostic_code)) continue;
      const args = item.arguments;
      if (!object(args) || typeof args.version !== "string" || args.version.length > 100
        || typeof args.opaque_handoff_ref !== "string" || args.opaque_handoff_ref.length > 1_024) continue;
      const diagnostic = {
        version: response.version, status: response.status, category: response.category,
        diagnostic_code: response.diagnostic_code, phase: "open",
        ...(response.field === "opaque_handoff_ref" ? { field: response.field } : {}),
      };
      // Do not copy unknown diagnostic strings or arbitrary tool arguments.
      if (diagnostic.status !== "interrupted" || !["bootstrap", "session", "internal"].includes(diagnostic.category)) continue;
      failed = { operation: "executor.open", call_ordinal: ordinal,
        request_version: args.version, attempted_handoff_ref: args.opaque_handoff_ref, reported_diagnostic: diagnostic };
      correction = undefined;
      try {
        correction = validateAutomaticBuildOpenCallCorrection({
          version: "automatic_build_open_call_correction.v1", issued_handoff_ref: issuedRef,
          attempted_handoff_ref: args.opaque_handoff_ref, request_version: args.version,
          field: "opaque_handoff_ref", phase: "open",
          cause: HANDOFF.test(args.opaque_handoff_ref) ? "different_ref" : "invalid_ref",
          reported_diagnostic: diagnostic,
        });
      } catch { /* The real diagnostic remains visible; evidence cannot authorize correction. */ }
    }
  } finally { lines.close(); stream.destroy(); }
  if (!owned) throw new Error("child diagnostic ownership evidence is missing");
  return {
    version: "automatic_build_child_open_diagnostic.v1", child_id: childId, parent_id: parentId,
    status: failed ? "observed" : "evidence_missing", recent_operations: operations,
    connection_state: terminal ? "terminal" : bound ? "bound" : "unbound",
    ...(failed ? { failed_call: failed } : { missing: "completed executor.open call and structured error" }),
    ...(correction ? { open_call_correction: correction } : failed ? {
      correction_unavailable: failed.request_version !== "automatic_build_executor_open_request.v3"
        ? "supported open request version is missing"
        : failed.attempted_handoff_ref === issuedRef ? "actual handoff difference is missing"
          : "reported diagnostic does not support open correction",
    } : {}),
  };
}

export async function findExecutorChildRollout(sessionsRoot: string, childId: string): Promise<string | undefined> {
  if (!UUID.test(childId)) throw new Error("invalid child diagnostic identity");
  for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
    const file = path.join(sessionsRoot, entry.name);
    if (entry.isDirectory()) {
      const found = await findExecutorChildRollout(file, childId);
      if (found) return found;
    } else if (entry.name.endsWith(`-${childId}.jsonl`)) return file;
  }
  return undefined;
}
