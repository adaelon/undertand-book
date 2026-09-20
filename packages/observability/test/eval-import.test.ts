import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptLocalEvaluation, type EvalAdaptInput } from "../src/eval-adapt.js";
import type { EvalImportConsentV1 } from "../src/eval-consent.js";
import { FileEvalImportLedger, MemoryEvalImportLedger } from "../src/eval-import-ledger.js";
import {
  importEvaluationComparisonGroup,
  HttpEvalUploadTransport,
  type EvalUploadTransport,
  type LangSmithExperimentUploadBody,
} from "../src/eval-import.js";

const fixturePath = fileURLToPath(
  new URL("../../../fixtures/observability/ub_eval_export.v1-adapter.json", import.meta.url),
);
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Omit<EvalAdaptInput, "options">;
const options = {
  comparison_group_id: "comparison-fixture-1",
  external_experiment_id_prefix: "experiment-fixture",
  external_dataset_id: "123e4567-e89b-42d3-a456-426614174000",
  dataset_revision: "dataset-revision-1",
  source_revision_ref: "source-revision-1",
  execution_config_ref: "config-revision-1",
};

function packages(recorded: boolean) {
  const input = structuredClone(fixture);
  if (recorded) {
    const rows = [...(input.run.qa ?? []), ...(input.run.navigation ?? []), ...(input.run.restart ?? [])];
    rows.forEach((row, index) => {
      row.started_at = `2026-09-20T00:0${index}:00Z`;
      row.finished_at = `2026-09-20T00:0${index}:01Z`;
    });
  }
  return adaptLocalEvaluation({ ...input, options });
}

function consent(): EvalImportConsentV1 {
  return {
    version: "ub_eval_import_consent.v1",
    mode: "eval_content",
    comparison_group_id: options.comparison_group_id,
    dataset_revision: options.dataset_revision,
    systems: ["system-a", "system-b"],
    permitted_fields: ["inputs", "actual_outputs"],
  };
}

class RecordingTransport implements EvalUploadTransport {
  readonly bodies: LangSmithExperimentUploadBody[] = [];
  failAt: number | null = null;

  async upload(body: LangSmithExperimentUploadBody) {
    this.bodies.push(body);
    if (this.failAt === this.bodies.length) throw new Error("timeout after send");
    return {
      status: "confirmed" as const,
      remote_experiment_id: `remote-${this.bodies.length}`,
      remote_dataset_id: "remote-dataset",
    };
  }
}

describe("authorized evaluation import", () => {
  it("persists aligned row IDs and uncertain experiments across importer restarts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ub-eval-import-ledger-"));
    const file = path.join(root, "ledger.json");
    const first = new FileEvalImportLedger(file);
    const rowId = first.rowId(options.dataset_revision, "qa:case-1", 1);
    first.markExperimentUncertain("experiment-fixture-02", "LANGSMITH_UPLOAD_UNCERTAIN");
    const reopened = new FileEvalImportLedger(file);
    expect(reopened.rowId(options.dataset_revision, "qa:case-1", 1)).toBe(rowId);
    expect(reopened.experimentState("experiment-fixture-02")).toEqual({
      status: "uncertain",
      error_code: "LANGSMITH_UPLOAD_UNCERTAIN",
    });
    rmSync(root, { recursive: true, force: true });
  });

  it("uses the documented upload endpoint and keeps credentials out of the body", async () => {
    let deliver!: (value: { url: string; body: string; apiKey?: string; tenant?: string }) => void;
    const received = new Promise<{ url: string; body: string; apiKey?: string; tenant?: string }>(
      (resolve) => { deliver = resolve; },
    );
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        deliver({
          url: request.url ?? "",
          body,
          apiKey: request.headers["x-api-key"] as string | undefined,
          tenant: request.headers["x-tenant-id"] as string | undefined,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          experiment: { id: "remote-experiment" },
          dataset: { id: "remote-dataset" },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const values = packages(true);
    const bodyTransport = new HttpEvalUploadTransport({
      apiKey: "test-secret",
      apiUrl: `http://127.0.0.1:${address.port}`,
      workspaceId: "workspace-1",
    });
    const result = await importEvaluationComparisonGroup({
      packages: [values[0]],
      consent: { ...consent(), systems: ["system-a"] },
      ledger: new MemoryEvalImportLedger(),
      transport: bodyTransport,
    });
    server.close();
    expect(result.status).toBe("complete");
    const request = await received;
    expect(request.url).toBe("/api/v1/datasets/upload-experiment");
    expect(request.apiKey).toBe("test-secret");
    expect(request.tenant).toBe("workspace-1");
    expect(request.body).not.toContain("test-secret");
    expect(JSON.parse(request.body)).toMatchObject({
      dataset_id: options.external_dataset_id,
      experiment_name: "experiment-fixture-01",
    });
  });

  it("uploads complete recorded systems with aligned row UUIDs and preserved classifications", async () => {
    const values = packages(true);
    const ledger = new MemoryEvalImportLedger();
    const transport = new RecordingTransport();
    const result = await importEvaluationComparisonGroup({
      packages: values,
      consent: consent(),
      ledger,
      transport,
    });
    expect(result.status).toBe("complete");
    expect(result.experiments.map((item) => item.status)).toEqual(["confirmed", "confirmed"]);
    expect(transport.bodies).toHaveLength(2);
    const firstCaseA = transport.bodies[0].results.find((row) => row.run_name.includes("qa:case-1"))!;
    const firstCaseB = transport.bodies[1].results.find((row) => row.run_name.includes("qa:case-1"))!;
    expect(firstCaseA.row_id).toBe(firstCaseB.row_id);
    expect(firstCaseA.start_time).toBe("2026-09-20T00:00:00Z");
    expect(firstCaseB.error).toBe("PRODUCT_INCOMPLETE");
    expect(firstCaseB.evaluation_scores).toContainEqual({
      key: "quality.status",
      value: "product_failed",
    });
    expect(firstCaseB.evaluation_scores).not.toContainEqual(expect.objectContaining({
      key: "quality.status",
      score: 0,
    }));
    expect(firstCaseA.run_metadata.score_identities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: "quality.completeness",
        judgment_id: "judge-forward",
      }),
      expect.objectContaining({
        key: "quality.completeness",
        judgment_id: "judge-reverse",
      }),
    ]));
  });

  it("blocks the entire group before network when timing or consent is missing", async () => {
    const transport = new RecordingTransport();
    const elapsedOnly = packages(false);
    const timing = await importEvaluationComparisonGroup({
      packages: elapsedOnly,
      consent: consent(),
      ledger: new MemoryEvalImportLedger(),
      transport,
    });
    expect(timing.status).toBe("unsupported_missing_timing");
    expect(timing.missing_sample_ids).toHaveLength(4);
    expect(transport.bodies).toHaveLength(0);

    const denied = await importEvaluationComparisonGroup({
      packages: packages(true),
      consent: { ...consent(), systems: ["system-a"] },
      ledger: new MemoryEvalImportLedger(),
      transport,
    });
    expect(denied.status).toBe("unauthorized");
    expect(denied.experiments.every((item) => item.error_code === "EVAL_IMPORT_CONSENT_SYSTEM_MISMATCH"))
      .toBe(true);
    expect(transport.bodies).toHaveLength(0);
  });

  it("does not retry confirmed or uncertain experiment posts", async () => {
    const values = packages(true);
    const ledger = new MemoryEvalImportLedger();
    const transport = new RecordingTransport();
    transport.failAt = 2;
    const first = await importEvaluationComparisonGroup({
      packages: values,
      consent: consent(),
      ledger,
      transport,
    });
    expect(first).toMatchObject({
      status: "incomplete",
      experiments: [
        { status: "confirmed" },
        { status: "uncertain", error_code: "LANGSMITH_UPLOAD_UNCERTAIN" },
      ],
    });
    const callCount = transport.bodies.length;
    const second = await importEvaluationComparisonGroup({
      packages: values,
      consent: consent(),
      ledger,
      transport,
    });
    expect(second.experiments).toMatchObject([
      { status: "skipped" },
      { status: "uncertain", error_code: "LANGSMITH_UPLOAD_UNCERTAIN" },
    ]);
    expect(transport.bodies).toHaveLength(callCount);
  });

  it("rejects a row outside its experiment interval with zero network calls", async () => {
    const values = packages(true);
    values[0].rows[0].timing = {
      source: "recorded",
      started_at: "2026-09-20T00:11:00Z",
      finished_at: "2026-09-20T00:11:01Z",
    };
    const transport = new RecordingTransport();
    const result = await importEvaluationComparisonGroup({
      packages: values,
      consent: consent(),
      ledger: new MemoryEvalImportLedger(),
      transport,
    });
    expect(result.status).toBe("unsupported_missing_timing");
    expect(result.missing_sample_ids).toEqual([values[0].rows[0].sample_id]);
    expect(transport.bodies).toHaveLength(0);
  });
});
