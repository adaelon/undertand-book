import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCarrierCapacityEvidence,
  createCarrierReadResponse,
  EXECUTOR_CARRIER_SHAPES,
  EXECUTOR_CARRIER_TIERS,
  parseCarrierPayloadText,
  type ExecutorCarrierCaseResultV1,
} from "../../../apps/desktop/scripts/executor-carrier-capacity";
import { analyzeScenarioRoot } from "../../../apps/desktop/scripts/smoke-executor-carrier-capacity";

describe("Executor carrier capacity probe", () => {
  it("builds exact 8/16/32/64 KiB ASCII and CJK JSON-RPC result lines", () => {
    for (const tier of EXECUTOR_CARRIER_TIERS) {
      for (const shape of EXECUTOR_CARRIER_SHAPES) {
        const built = createCarrierReadResponse(7, tier, shape);
        expect(Buffer.byteLength(built.serialized_line, "utf8")).toBe(tier);
        const parsed = parseCarrierPayloadText(built.response.result.content[0].text);
        expect(parsed.serialized_result_bytes).toBe(tier);
        expect(parsed.shape).toBe(shape);
        expect(parsed.tail_sentinel).toBe(`M2_${shape.toUpperCase()}_${tier}_TAIL`);
        expect(JSON.parse(built.response.result.content[0].text)).toEqual(built.payload);
      }
    }
  });

  it("summarizes passing tiers and the first bounded failure without payload fields", () => {
    const cases: ExecutorCarrierCaseResultV1[] = [
      ...[8192, 16384].map((tier_bytes) => ({
        mode: "direct_result" as const,
        shape: "ascii" as const,
        tier_bytes,
        status: "passed" as const,
        exact_result_bytes: tier_bytes,
        raw_tail_complete: true,
        structure_closed: true,
        model_ack_complete: true,
        failure_kind: null,
      })),
      {
        mode: "direct_result",
        shape: "ascii",
        tier_bytes: 32768,
        status: "failed",
        exact_result_bytes: null,
        raw_tail_complete: false,
        structure_closed: false,
        model_ack_complete: false,
        failure_kind: "host_rejected",
      },
      {
        mode: "program_output",
        shape: "cjk",
        tier_bytes: 65536,
        status: "passed",
        exact_result_bytes: 65536,
        raw_tail_complete: true,
        structure_closed: true,
        model_ack_complete: true,
        failure_kind: null,
      },
    ];

    const evidence = buildCarrierCapacityEvidence("codex-cli 0.149.0", cases);
    expect(evidence.direct_result).toEqual({
      max_tested_passing_bytes: 16384,
      first_failed_bytes: 32768,
    });
    expect(evidence.program_output).toEqual({
      max_tested_passing_bytes: 65536,
      first_failed_bytes: null,
    });
    expect(JSON.stringify(evidence)).not.toMatch(/body|pad|sentinel|payload|hash|digest/u);
  });

  it("replays direct raw results and compact program output from reduced synthetic traces", () => {
    const root = mkdtempSync(path.join(tmpdir(), "executor-carrier-analyzer-"));
    try {
      for (const mode of ["direct_result", "program_output"] as const) {
        const scenario = path.join(root, mode);
        const bundle = path.join(scenario, "trace", "bundle");
        const payloadRoot = path.join(bundle, "payloads");
        const ledger = path.join(scenario, "ledger");
        mkdirSync(payloadRoot, { recursive: true });
        mkdirSync(ledger, { recursive: true });
        const rawPayloads: Record<string, unknown> = {};
        const toolCalls: Record<string, unknown> = {};
        const responseLedger: unknown[] = [];
        const ackLedger: unknown[] = [];
        const programCases: unknown[] = [];
        for (const [index, tier] of EXECUTOR_CARRIER_TIERS.entries()) {
          const built = createCarrierReadResponse(index + 1, tier, "ascii");
          responseLedger.push({
            version: "executor_carrier_response_observation.v1",
            mode,
            shape: "ascii",
            tier_bytes: tier,
            serialized_result_bytes: tier,
            content_utf8_bytes: built.payload.content_utf8_bytes,
          });
          ackLedger.push({
            version: "executor_carrier_ack_observation.v1",
            mode,
            shape: "ascii",
            tier_bytes: tier,
            content_utf8_bytes: built.payload.content_utf8_bytes,
            tail_complete: true,
            structure_closed: true,
          });
          programCases.push({
            tier_bytes: tier,
            content_utf8_bytes: built.payload.content_utf8_bytes,
            tail_complete: true,
            structure_closed: true,
          });
          if (mode === "direct_result") {
            const invocationId = `invocation-${tier}`;
            const resultId = `result-${tier}`;
            writeFileSync(path.join(payloadRoot, `${invocationId}.json`), JSON.stringify({
              tool_namespace: "mcp__executor_carrier_capacity",
              tool_name: "carrier_read",
            }));
            writeFileSync(path.join(payloadRoot, `${resultId}.json`), JSON.stringify({
              type: "code_mode_response",
              value: built.response.result,
            }));
            rawPayloads[invocationId] = { path: `payloads/${invocationId}.json` };
            rawPayloads[resultId] = { path: `payloads/${resultId}.json` };
            toolCalls[`call-${tier}`] = {
              thread_id: "child",
              raw_invocation_payload_id: invocationId,
              raw_result_payload_id: resultId,
              execution: { status: "completed" },
            };
          }
        }
        writeFileSync(
          path.join(ledger, "responses.jsonl"),
          `${responseLedger.map((value) => JSON.stringify(value)).join("\n")}\n`,
        );
        writeFileSync(
          path.join(ledger, "acks.jsonl"),
          `${ackLedger.map((value) => JSON.stringify(value)).join("\n")}\n`,
        );
        writeFileSync(path.join(bundle, "state.json"), JSON.stringify({
          root_thread_id: "root",
          raw_payloads: rawPayloads,
          tool_calls: toolCalls,
          conversation_items: mode === "program_output"
            ? {
                output: {
                  thread_id: "child",
                  kind: "custom_tool_call_output",
                  body: {
                    parts: [{
                      type: "text",
                      text: JSON.stringify({
                        version: "executor_carrier_program_output.v1",
                        cases: programCases,
                      }),
                    }],
                  },
                },
              }
            : {},
        }));
        expect(analyzeScenarioRoot(scenario, mode, "ascii"))
          .toHaveLength(EXECUTOR_CARRIER_TIERS.length);
        expect(analyzeScenarioRoot(scenario, mode, "ascii").every((item) => item.status === "passed"))
          .toBe(true);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
