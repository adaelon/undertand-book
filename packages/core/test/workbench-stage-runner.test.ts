import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectBuildReadiness, readBuildWorkbenchSnapshot } from "../src/build-workbench";
import { runWorkbenchStage, workbenchStageCommand } from "../src/workbench-stage-runner";

function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function simplePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 100 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${asciiBytes(stream).length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(asciiBytes(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = asciiBytes(pdf).length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return asciiBytes(pdf);
}

function workspace(markdown: string, pdfText: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "understand-book-stage-runner-"));
  writeFileSync(path.join(dir, "paper.md"), markdown, "utf8");
  writeFileSync(path.join(dir, "paper.pdf"), simplePdf(pdfText));
  const fingerprint = {
    paper_md_sha256: "md-fixture",
    paper_pdf_sha256: "pdf-fixture",
    config_hash: "workbench-fixture-v1",
  };
  mkdirSync(path.join(dir, ".build", "input"), { recursive: true });
  writeFileSync(path.join(dir, ".build", "input", "manifest.json"), JSON.stringify({
    version: "workbench_input_manifest.v1",
    book_id: "paper-stage-fixture",
    profile_id: "paper",
    display_title: "Fixture",
    inputs: {
      paper_md: { path: "paper.md", sha256: fingerprint.paper_md_sha256 },
      paper_pdf: { path: "paper.pdf", sha256: fingerprint.paper_pdf_sha256 },
    },
    config_hash: fingerprint.config_hash,
    fingerprint,
    trusted: false,
  }, null, 2));
  mkdirSync(path.join(dir, ".build", "jobs"), { recursive: true });
  writeFileSync(path.join(dir, ".build", "jobs", "job_fixture.json"), JSON.stringify({
    version: "build_job_state.v1",
    job_id: "job_fixture",
    book_id: "paper-stage-fixture",
    input_fingerprint: fingerprint,
    status: "running",
    events: [],
    decision_requests: [],
    permission_requests: [],
    created_at: "1",
    updated_at: "1",
  }, null, 2));
  return { dir, fingerprint };
}

describe("PH17 Workbench deterministic stage runtime", () => {
  it("routes packaged projection stages through the compiled build sidecar", async () => {
    const { dir } = workspace("Hello PDF\n", "Hello PDF");
    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "hybrid_foundation", now: "3" });
    const previous = process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
    process.env.UNDERSTAND_BOOK_SIDECAR_SELF = "C:\\Program Files\\Understand Book\\understand-book-build.exe";
    try {
      const command = workbenchStageCommand(dir, "paper_reading_guide");
      expect(command.command).toBe(process.env.UNDERSTAND_BOOK_SIDECAR_SELF);
      expect(command.args).toEqual([
        "run-script",
        "verify-paper-reading-guide.ts",
        dir,
      ]);
      expect(command.args.every((arg) => !arg.includes("node_modules") && !arg.includes("tsx"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.UNDERSTAND_BOOK_SIDECAR_SELF;
      else process.env.UNDERSTAND_BOOK_SIDECAR_SELF = previous;
    }
  });

  it("runs source reconciliation and hybrid foundation to the reader trust gate", async () => {
    const { dir, fingerprint } = workspace("Hello PDF\n", "Hello PDF");

    const sourceJob = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    expect(sourceJob.status).toBe("ready");
    expect(existsSync(path.join(dir, ".build", "source-reconciliation", "source.txt"))).toBe(true);

    const foundationJob = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "hybrid_foundation", now: "3" });
    expect(foundationJob.status).toBe("done");
    expect(existsSync(path.join(dir, "base.json"))).toBe(true);
    expect(detectBuildReadiness(readBuildWorkbenchSnapshot(dir, { current_input_fingerprint: fingerprint })).route).toBe("reader");

    const commands: Array<{ command: string; args: string[] }> = [];
    const projectionJob = await runWorkbenchStage({
      book_dir: dir,
      job_id: "job_fixture",
      stage: "paper_reading_guide",
      now: "4",
      command_runner: async (spec) => {
        commands.push({ command: spec.command, args: spec.args });
        return { exit_code: 0, stdout: "guide ready", stderr: "" };
      },
    });
    expect(projectionJob.status).toBe("done");
    expect(commands).toHaveLength(1);
    expect(commands[0].command).toBe(process.execPath);
    expect(commands[0].args.some((arg) => arg.endsWith("verify-paper-reading-guide.ts"))).toBe(true);
    expect(existsSync(path.join(dir, ".build", "paper-reading-guide", "completion.json"))).toBe(true);
  });

  it("preserves a same-LID semantic graph when hybrid foundation reruns", async () => {
    const { dir } = workspace("Hello PDF\n", "Hello PDF");
    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "hybrid_foundation", now: "3" });
    const basePath = path.join(dir, "base.json");
    const base = JSON.parse(readFileSync(basePath, "utf8"));
    const anchorLid = base.lid_nodes.find((node: { children: string[] }) => node.children.length === 0).lid;
    const graphNodes = [{
      id: "concept:hello",
      type: "concept",
      name: "Hello",
      occurrences: [anchorLid],
      source_lid: null,
    }, {
      id: `claim:${anchorLid}:hello`,
      type: "claim",
      name: "Hello PDF",
      occurrences: [],
      source_lid: anchorLid,
    }];
    const graphEdges = [{
      source: "concept:hello",
      target: `claim:${anchorLid}:hello`,
      type: "supports",
      direction: "directed",
      scope: "local",
      weight: 1,
    }];
    writeFileSync(basePath, JSON.stringify({ ...base, graph_nodes: graphNodes, graph_edges: graphEdges }, null, 2));

    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "hybrid_foundation", now: "4" });
    const after = JSON.parse(readFileSync(basePath, "utf8"));

    expect(after.graph_nodes).toEqual(graphNodes);
    expect(after.graph_edges).toEqual(graphEdges);
  });

  it("blocks for review, then applies recorded PDF evidence and reruns the same gate", async () => {
    const { dir } = workspace("The measured value is 42 mg.\n", "The measured value is 43 mg.");

    const blocked = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    expect(blocked.status).toBe("needs_user");
    expect(blocked.decision_requests).toHaveLength(1);
    const report = JSON.parse(readFileSync(path.join(dir, ".build", "source-reconciliation", "report.json"), "utf8"));
    expect(report.unresolved[0].pdf_excerpt).toBe("The measured value is 43 mg.");

    writeFileSync(path.join(dir, ".build", "source-reconciliation", "review-decisions.json"), JSON.stringify({
      version: "source_review_decisions.v1",
      book_id: "paper-stage-fixture",
      stage: "source_reconciliation",
      decisions: [{ block_id: "block-1", decision: "accept_pdf", resolved_at: "3" }],
    }, null, 2));
    const completed = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "4" });

    expect(completed.status).toBe("ready");
    expect(readFileSync(path.join(dir, ".build", "source-reconciliation", "source.txt"), "utf8")).toBe("The measured value is 43 mg.\n");
    expect(completed.decision_requests[0].status).toBe("answered");
  });

  it("keeps canonical caption spans through accept-Markdown review and final source", async () => {
    const canonical = "The figure value is 42 mg.\n";
    const raw = `<div style="text-align: center;"><div style="text-align: center;">${canonical.trim()}</div> </div>\n`;
    const { dir } = workspace(raw, "The figure value is 43 mg.");

    const blocked = await runWorkbenchStage({
      book_dir: dir,
      job_id: "job_fixture",
      stage: "source_reconciliation",
      now: "2",
    });
    expect(blocked.status).toBe("needs_user");
    const report = JSON.parse(readFileSync(
      path.join(dir, ".build", "source-reconciliation", "report.json"),
      "utf8",
    ));
    expect(report.unresolved[0].md_excerpt).toBe(canonical.trim());

    writeFileSync(path.join(dir, ".build", "source-reconciliation", "review-decisions.json"), JSON.stringify({
      version: "source_review_decisions.v1",
      book_id: "paper-stage-fixture",
      stage: "source_reconciliation",
      decisions: [{ block_id: report.unresolved[0].id, decision: "accept_markdown", resolved_at: "3" }],
    }, null, 2));
    const completed = await runWorkbenchStage({
      book_dir: dir,
      job_id: "job_fixture",
      stage: "source_reconciliation",
      now: "4",
    });

    expect(completed.status).toBe("ready");
    expect(readFileSync(path.join(dir, ".build", "source-reconciliation", "reviewed-draft.md"), "utf8"))
      .toBe(canonical);
    expect(readFileSync(path.join(dir, ".build", "source-reconciliation", "source.txt"), "utf8"))
      .toBe(canonical);
  });

  it("accepts residual issues after one complete reviewed rerun without requesting review again", async () => {
    const { dir } = workspace("The measured value is 42 mg.\n", "The measured value is 43 mg.");

    const blocked = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    expect(blocked.status).toBe("needs_user");
    writeFileSync(path.join(dir, ".build", "source-reconciliation", "review-decisions.json"), JSON.stringify({
      version: "source_review_decisions.v1",
      book_id: "paper-stage-fixture",
      stage: "source_reconciliation",
      decisions: [{ block_id: "block-1", decision: "accept_markdown", resolved_at: "3" }],
    }, null, 2));

    const completed = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "4" });
    const reportPath = path.join(dir, ".build", "source-reconciliation", "report.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    expect(completed.status).toBe("ready");
    expect(completed.decision_requests).toMatchObject([{ status: "answered" }]);
    expect(completed.events.at(-1)?.type).toBe("stage_completed");
    expect(readFileSync(path.join(dir, ".build", "source-reconciliation", "source.txt"), "utf8"))
      .toBe("The measured value is 42 mg.\n");
    expect(report.unresolved).toHaveLength(1);
    expect(report.acceptance).toEqual({
      mode: "manual_override",
      policy: "single_review_then_override_v1",
      accepted_at: "4",
      residual_unresolved_count: 1,
      decision_count: 1,
    });

    const repeated = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "5" });
    const repeatedReport = JSON.parse(readFileSync(reportPath, "utf8"));
    expect(repeated.status).toBe("ready");
    expect(repeatedReport.acceptance.accepted_at).toBe("4");
    expect(repeated.decision_requests.some((request) => request.status === "pending")).toBe(false);
  });

  it("preserves partial current decisions without failing or applying an incomplete review", async () => {
    const { dir, fingerprint } = workspace(
      "The measured value is 42 mg.\n\nThe cohort has 12 patients.\n",
      "The measured value is 43 mg. The cohort has 21 patients.",
    );
    await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "2" });
    writeFileSync(path.join(dir, ".build", "source-reconciliation", "review-decisions.json"), JSON.stringify({
      version: "source_review_decisions.v1",
      book_id: "paper-stage-fixture",
      stage: "source_reconciliation",
      input_fingerprint: fingerprint,
      decisions: [{ block_id: "block-1", decision: "accept_markdown", resolved_at: "3" }],
    }, null, 2));

    const partial = await runWorkbenchStage({ book_dir: dir, job_id: "job_fixture", stage: "source_reconciliation", now: "4" });
    const persisted = JSON.parse(readFileSync(path.join(dir, ".build", "source-reconciliation", "review-decisions.json"), "utf8"));

    expect(partial.status).toBe("needs_user");
    expect(partial.failure_summary).toBeUndefined();
    expect(persisted.decisions).toEqual([{ block_id: "block-1", decision: "accept_markdown", resolved_at: "3" }]);
    expect(existsSync(path.join(dir, ".build", "source-reconciliation", "source.txt"))).toBe(false);
  });
});
