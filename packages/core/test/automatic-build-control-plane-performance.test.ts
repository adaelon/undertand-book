import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { describe, it, expect, vi } from "vitest";
import { createControlPlanePerformanceFixture } from "./helpers/control-plane-performance-fixture";
import { buildAutomaticBuildSnapshot } from "../src/build-orchestrator";
import { automaticBuildPlan } from "../../../skills/build/automatic-build";
import { automaticBuildStep } from "../../../skills/build/automatic-build-driver";
import { createBuildExecutorMcpSession } from "../../../skills/build/build-executor-mcp";
import { BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3 } from "../src/build-executor-connection-capability";
import { readAutomaticBuildAttemptSnapshot } from "../src/automatic-build-task-store";
import { automaticBuildGenerationArtifactPath } from "../src/semantic-artifact";
import type { AutomaticBuildExecutorSessionResponseV3 } from "../src/automatic-build-executor-session";
import {
  createExecutorOuterTimingRecorder, reduceExecutorMcpTiming,
  type ExecutorTraceOperation, type ExecutorMcpServerTimingV2, type ExecutorMcpTimingJoinV2,
} from "../../../apps/desktop/scripts/r7-rollout-trace";

type FileOperation = "readFileSync" | "existsSync" | "readdirSync" | "mkdirSync" | "writeFileSync";
interface Observation {
  calls: Record<FileOperation, number>;
  write_success: number;
  create_success: number;
  eexist: number;
  other_write_errors: number;
  snapshot_count: number;
  counter_bookkeeping_ms: number;
  write_paths: Map<string, number>;
}
const meter = vi.hoisted(() => ({ active: undefined as Observation | undefined }));

// Real synchronous disk operations; wrappers only observe, and are inactive during setup/reset.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const wrapped = { ...actual };
  for (const name of ["readFileSync", "existsSync", "readdirSync", "mkdirSync", "writeFileSync"] as const) {
    const original = actual[name] as (...args: unknown[]) => unknown;
    Object.assign(wrapped, { [name]: (...args: unknown[]) => {
      const active = meter.active;
      if (!active) return original(...args);
      const entered = performance.now();
      active.calls[name] += 1;
      if (name === "writeFileSync") {
        const file = String(args[0]);
        active.write_paths.set(file, (active.write_paths.get(file) ?? 0) + 1);
      }
      active.counter_bookkeeping_ms += performance.now() - entered;
      try {
        const value = original(...args);
        const finished = performance.now();
        if (name === "writeFileSync") {
          active.write_success += 1;
          if (typeof args[2] === "object" && args[2] !== null
            && "flag" in args[2] && ["wx", "wx+", "ax", "ax+"].includes(String(args[2].flag))) {
            active.create_success += 1;
          }
        }
        active.counter_bookkeeping_ms += performance.now() - finished;
        return value;
      } catch (error) {
        const finished = performance.now();
        if (name === "writeFileSync") {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") active.eexist += 1;
          else active.other_write_errors += 1;
        }
        active.counter_bookkeeping_ms += performance.now() - finished;
        throw error;
      }
    } });
  }
  return wrapped;
});

vi.mock("../src/build-orchestrator", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/build-orchestrator")>();
  return {
    ...actual,
    buildAutomaticBuildSnapshot: (...args: Parameters<typeof actual.buildAutomaticBuildSnapshot>) => {
      if (meter.active) meter.active.snapshot_count += 1;
      return actual.buildAutomaticBuildSnapshot(...args);
    },
    routeAutomaticBuildSnapshot: (...args: Parameters<typeof actual.routeAutomaticBuildSnapshot>) => {
      if (meter.active) meter.active.snapshot_count += 1;
      return actual.routeAutomaticBuildSnapshot(...args);
    },
  };
});

function measure<T>(operation: string, run: () => T) {
  if (meter.active) throw new Error("B1 observation boundaries must not nest");
  const observation: Observation = {
    calls: { readFileSync: 0, existsSync: 0, readdirSync: 0, mkdirSync: 0, writeFileSync: 0 },
    write_success: 0, create_success: 0, eexist: 0, other_write_errors: 0,
    snapshot_count: 0, counter_bookkeeping_ms: 0, write_paths: new Map(),
  };
  const start = performance.now();
  meter.active = observation;
  let value: T;
  try { value = run(); } finally { meter.active = undefined; }
  const elapsed_ms = performance.now() - start;
  const { write_paths, ...aggregate } = observation;
  return { value, metrics: {
    operation, elapsed_ms, ...aggregate,
    unique_write_paths: write_paths.size,
    max_write_attempts_per_path: Math.max(0, ...write_paths.values()),
  } };
}

function diskImage(root: string): { files: Map<string, Buffer>; directories: string[] } {
  const files = new Map<string, Buffer>();
  const directories: string[] = [];
  const visit = (relative: string) => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) { directories.push(child); visit(child); }
      else files.set(child, fs.readFileSync(path.join(root, child)));
    }
  };
  visit("");
  return { files, directories };
}

function restoreDiskImage(root: string, saved: ReturnType<typeof diskImage>) {
  // Only paths enumerated under this mkdtemp root are removed. Restore the SAME absolute paths.
  const current = diskImage(root);
  for (const file of current.files.keys()) {
    if (!saved.files.has(file)) fs.unlinkSync(path.join(root, file));
  }
  const kept = new Set(saved.directories);
  for (const directory of [...current.directories].reverse()) {
    if (!kept.has(directory)) fs.rmdirSync(path.join(root, directory));
  }
  for (const directory of saved.directories) fs.mkdirSync(path.join(root, directory), { recursive: true });
  for (const [file, bytes] of saved.files) fs.writeFileSync(path.join(root, file), bytes);
  const restored = diskImage(root);
  expect(restored.directories).toEqual(saved.directories);
  expect([...restored.files.keys()]).toEqual([...saved.files.keys()]);
  for (const [file, bytes] of saved.files) {
    if (!restored.files.get(file)?.equals(bytes)) throw new Error("B1 initial disk state differs");
  }
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

describe("B1 representative control plane", () => {
  it("separates a successful exclusive create, an overwrite, and an existing-file rejection", () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "understand-book-b1-counter-"));
    try {
      const file = path.join(root, "counter.json");
      const observed = measure("counter-contract", () => {
        fs.mkdirSync(path.join(root, "nested"));
        fs.writeFileSync(file, "first", { flag: "wx" });
        fs.writeFileSync(file, "second");
        expect(() => fs.writeFileSync(file, "rejected", { flag: "wx" })).toThrow();
        expect(fs.readFileSync(file, "utf8")).toBe("second");
        expect(fs.existsSync(file)).toBe(true);
        fs.readdirSync(root);
      }).metrics;
      expect(observed).toMatchObject({
        calls: { readFileSync: 1, existsSync: 1, readdirSync: 1, mkdirSync: 1, writeFileSync: 3 },
        write_success: 2, create_success: 1, eexist: 1, other_write_errors: 0,
        unique_write_paths: 1, max_write_attempts_per_path: 3,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("measures the initial sample and three identical-state warm samples through real stores and MCP", async () => {
    const priorRegistry = process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T14:00:00.000Z"));
    const root = fs.mkdtempSync(path.join(tmpdir(), "understand-book-control-plane-b1-"));
    try {
      const current = await createControlPlanePerformanceFixture(root);
      const snapshot = buildAutomaticBuildSnapshot(current.target);
      const state = snapshot.stages.map((stage) => ({ stage: stage.stage, units: stage.work_units?.length, pending: stage.pending_work_units?.length, closed: stage.closed }));
      expect(state).toEqual([
        { stage: "pass1", units: 205, pending: 0, closed: true },
        { stage: "profile_sidecar", units: 315, pending: 251, closed: false },
      ]);
      expect(new Set(current.dispatches.map((dispatch) => dispatch.opaque_handoff_ref)).size).toBe(3);
      const sidecar = snapshot.stages[1];
      const envelope = current.dispatches[0];
      const unitId = envelope.manifest.ordered_work_unit_ids[0];
      const generation = sidecar.generation_tasks?.[unitId];
      if (generation?.kind !== "profile_sidecar_fast_path") throw new Error("B1 requires a frozen independent sidecar task");
      const packet = generation.task.packet;
      const candidate = packet.unit_kind === "profile_sidecar_discourse"
        ? { discourse_items: packet.visible_lids.map((lid) => ({ lid, mode: "informative", relations: [] })) }
        : { formula_semantics: packet.formula_lids.map((lid) => ({
          formula_lid: lid, context_lids: packet.visible_lids.filter((other) => other !== lid),
          composition: { source_lid: lid, meaning: "The value increases with its input.", terms: [], evidence_lids: [lid] },
        })) };
      const initial = diskImage(current.root);
      const accepted = [...initial.files].filter(([file]) => file.includes(path.join("v3", "artifacts") + path.sep));
      expect(accepted).toHaveLength(269);
      const newArtifact = automaticBuildGenerationArtifactPath(current.target, "profile_sidecar", generation.task.policy_generation_id, unitId);
      expect(fs.existsSync(newArtifact)).toBe(false);
      const samples: Array<{
        sample: string; observations: ReturnType<typeof measure>["metrics"][];
        timing: ExecutorMcpTimingJoinV2; semantic_attempts: number; durable_commits: number;
      }> = [];
      // Uninstrumented snapshot comparison is diagnostic, outside every measured sample.
      const plainStart = performance.now();
      buildAutomaticBuildSnapshot(current.target);
      const uninstrumented_snapshot_ms = performance.now() - plainStart;
      await setImmediate();
      for (let index = 0; index < 4; index += 1) {
        restoreDiskImage(current.root, initial);
        await setImmediate();
        const observations: ReturnType<typeof measure>["metrics"][] = [];
        const observedSnapshot = measure("snapshot", () => buildAutomaticBuildSnapshot(current.target));
        observations.push(observedSnapshot.metrics);
        expect(observedSnapshot.value.stages.map((stage) => ({ stage: stage.stage, units: stage.work_units?.length, pending: stage.pending_work_units?.length, closed: stage.closed }))).toEqual(state);
        expect(observedSnapshot.metrics.snapshot_count).toBe(1);
        expect(observedSnapshot.metrics.eexist).toBe(0);
        expect(observedSnapshot.metrics.calls.mkdirSync).toBe(0);
        expect(observedSnapshot.metrics.calls.writeFileSync).toBe(0);
        expect(observedSnapshot.metrics.max_write_attempts_per_path).toBe(0);
        await setImmediate();
        observations.push(measure("plan", () => automaticBuildPlan(current.sourceFile, current.root, {
          requested_workers: 3, available_agent_slots: 3, build_plan: current.buildPlan,
        })).metrics);
        await setImmediate();
        const step = measure("build.step", () => automaticBuildStep({
          version: "automatic_build_step_request.v1", invocation_ref: current.invocation.invocation_ref,
          available_agent_slots: 3,
        }));
        expect(step.value.action.kind, JSON.stringify(step.value.action)).toBe("SPAWN_EXECUTORS");
        if (step.value.action.kind === "SPAWN_EXECUTORS") {
          expect(step.value.action.executors.map((executor) => executor.opaque_handoff_ref).sort())
            .toEqual(current.dispatches.map((dispatch) => dispatch.opaque_handoff_ref).sort());
        }
        expect(step.metrics.snapshot_count).toBe(1);
        observations.push(step.metrics);
        await setImmediate();
        const server: ExecutorMcpServerTimingV2[] = [];
        const connectionId = `sample-${index}-connection-1`;
        const outer = createExecutorOuterTimingRecorder(connectionId);
        const mcp = createBuildExecutorMcpSession({
          bootstrap_version: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.version,
          protocol_generation: BUILD_EXECUTOR_BOOTSTRAP_CONTRACT_V3.session_protocol,
          session_private_root: path.join(current.root, "connection-private"),
          timing_sample_sink: (sample) => server.push(sample),
        });
        let ordinal = 0;
        const call = (operation: ExecutorTraceOperation, request: unknown) => {
          const observed = measure(operation, () => {
            const finish = outer.begin(operation);
            try { return mcp.handle_message({ jsonrpc: "2.0", id: ++ordinal, method: "tools/call", params: { name: operation, arguments: request } }); }
            finally { finish(); }
          });
          expect(observed.metrics.snapshot_count).toBe(0);
          observations.push(observed.metrics);
          const rpc = observed.value as { result?: { isError: boolean; content: { text: string }[] }; error?: unknown };
          expect(rpc.error).toBeUndefined();
          expect(rpc.result?.isError, rpc.result?.content[0]?.text).toBe(false);
          return (JSON.parse(rpc.result!.content[0].text) as AutomaticBuildExecutorSessionResponseV3).action;
        };
        const opened = call("executor.open", { version: "automatic_build_executor_open_request.v3", opaque_handoff_ref: envelope.opaque_handoff_ref });
        if (opened.kind !== "DELIVER_INPUT") throw new Error(`B1 open: ${opened.kind}`);
        await setImmediate();
        const batch = call("executor.input.next", opened.next_request);
        if (batch.kind !== "INPUT_BATCH" || !batch.batch.final_for_generation) throw new Error("B1 requires one complete input batch");
        await setImmediate();
        const started = call("executor.generation.start", {
          version: "automatic_build_executor_generation_start_request.v3", opaque_session_ref: batch.batch.opaque_session_ref,
          generation_input_ref: batch.batch.generation_input_ref, confirmed_through_ordinal: batch.batch.last_ordinal,
        });
        if (started.kind !== "GENERATE") throw new Error(`B1 start: ${started.kind}`);
        await setImmediate();
        const committed = call("executor.submit_candidate", {
          version: "automatic_build_executor_candidate_submit.v3", opaque_session_ref: started.opaque_session_ref,
          candidate_sink_ref: started.candidate_sink_ref, candidate,
        });
        expect(committed).toMatchObject({ kind: "DONE", status: "committed" });
        expect(fs.existsSync(newArtifact)).toBe(true);
        for (const [file, bytes] of accepted) {
          if (!fs.readFileSync(path.join(current.root, file)).equals(bytes)) throw new Error("B1 changed an accepted artifact");
        }
        expect(readAutomaticBuildAttemptSnapshot(current.target).stages.profile_sidecar?.[unitId]).toMatchObject({ semantic_attempt: 1, failures: 0, submit_revision: 1 });
        const timing = reduceExecutorMcpTiming({ connections: [{ thread_id: connectionId, samples: server }], outer_samples: outer.samples });
        expect(timing.samples).toHaveLength(4);
        for (const observed of observations) {
          expect(observed.calls.writeFileSync).toBe(observed.write_success + observed.eexist + observed.other_write_errors);
          expect(observed.counter_bookkeeping_ms / observed.elapsed_ms).toBeLessThan(0.1);
        }
        samples.push({ sample: index === 0 ? "initial" : `warm-${index}`, observations, timing, semantic_attempts: 1, durable_commits: 1 });
        console.info(`B1 ${samples.at(-1)!.sample} captured: seven operations, four matched MCP calls, one durable commit`);
        await setImmediate();
      }
      const warm = samples.slice(1);
      const counts = (sample: typeof samples[number]) => sample.observations.map(({ elapsed_ms, counter_bookkeeping_ms, ...rest }) => rest);
      for (const sample of warm) expect(counts(sample)).toEqual(counts(samples[0]));
      const report = {
        version: "control_plane_b1_baseline.v1", fixture: { state, active_dispatch_slots: 3, measured_connections_per_sample: 1 },
        runtime: { node: process.version, platform: process.platform, architecture: process.arch, fixture_drive: path.parse(current.root).root.replace(/[\\/]/g, ""), model: "deterministic synthetic candidate; no model call" },
        uninstrumented_snapshot_ms,
        samples,
        warm_medians: warm[0].observations.map((observation, operationIndex) => ({
          operation: observation.operation,
          elapsed_ms: median(warm.map((sample) => sample.observations[operationIndex].elapsed_ms)),
          counter_bookkeeping_ms: median(warm.map((sample) => sample.observations[operationIndex].counter_bookkeeping_ms)),
        })),
        limitations: [
          "Initial means first measured sample after fixture setup, not a cold process or cold file cache.",
          "All four samples restore identical bytes and directories at identical paths, with Date fixed; performance.now remains real.",
          "Outer timing surrounds the real in-process MCP handler; host transport and model inference are not measured.",
          "Three real dispatch slots are reserved; one connection commits one independent unit per sample. No live child occupancy claim.",
          "Counters delegate to real disk calls in this process. Subprocess I/O is outside the counters; fixture close occurs before measurement.",
          "Counter bookkeeping is a lower bound on instrumentation cost; the uninstrumented snapshot is a diagnostic, not a speedup comparison.",
        ],
      };
      const output = process.env.UNDERSTAND_BOOK_B1_REPORT;
      if (output) fs.writeFileSync(path.resolve(output), `${JSON.stringify(report, null, 2)}\n`);
      console.info("B1 warm medians", report.warm_medians);
    } finally {
      meter.active = undefined;
      vi.useRealTimers();
      if (priorRegistry === undefined) delete process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT;
      else process.env.UNDERSTAND_BOOK_AUTOMATIC_BUILD_DRIVER_ROOT = priorRegistry;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 1_200_000);
});
