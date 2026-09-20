import type { ExportLedger } from "./export-ledger.js";
import type { LangSmithRunClient } from "./langsmith-client.js";
import type { PrebuildObservationV1 } from "./prebuild-projector.js";

export interface PrebuildExportResult {
  sent: string[];
  skipped: string[];
  failed: Array<{ identity: string; error: string }>;
}

function metadata(observation: PrebuildObservationV1): Record<string, unknown> {
  return {
    ub_prebuild_observation: observation,
    projection_source: "durable_receipts",
  };
}

function hasValidTiming(observation: PrebuildObservationV1): boolean {
  const { started_at: startedAt, finished_at: finishedAt } = observation.timing;
  if (!startedAt || !finishedAt) return false;
  const startedMs = Date.parse(startedAt);
  const finishedMs = Date.parse(finishedAt);
  return Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs;
}

export async function exportPrebuildObservations(input: {
  observations: readonly PrebuildObservationV1[];
  project: string;
  client: LangSmithRunClient;
  ledger: ExportLedger;
}): Promise<PrebuildExportResult> {
  const result: PrebuildExportResult = { sent: [], skipped: [], failed: [] };
  for (const observation of input.observations) {
    const entry = input.ledger.ensure(observation.observation_identity);
    if (entry.last_revision >= observation.revision) {
      result.skipped.push(observation.observation_identity);
      continue;
    }
    if (!hasValidTiming(observation)) {
      result.failed.push({
        identity: observation.observation_identity,
        error: "PREBUILD_TIMING_UNAVAILABLE",
      });
      continue;
    }
    const startedAt = observation.timing.started_at!;
    const finishedAt = observation.timing.finished_at!;
    try {
      if (entry.last_revision === 0) {
        await input.client.createRun({
          id: entry.run_id,
          name: `prebuild.${observation.stage}.${observation.work_unit_id}`,
          run_type: "chain",
          project_name: input.project,
          start_time: startedAt,
          end_time: finishedAt,
          inputs: {},
          outputs: {},
          extra: { metadata: metadata(observation) },
        });
      } else {
        await input.client.updateRun(entry.run_id, {
          end_time: finishedAt,
          outputs: {},
          extra: { metadata: metadata(observation) },
        });
      }
      input.ledger.confirm(observation.observation_identity, observation.revision);
      result.sent.push(observation.observation_identity);
    } catch (error) {
      result.failed.push({
        identity: observation.observation_identity,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
