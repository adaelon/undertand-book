import type { EvalScore, UbEvalExportV1 } from "./eval-export-contract.js";

export interface LangSmithFeedback {
  key: string;
  score?: number;
  value?: string;
}

function boundedKey(value: string): string {
  return value.replace(/[^A-Za-z0-9._:/-]/gu, "_").slice(0, 256);
}

export function evalScoreFeedback(score: EvalScore): LangSmithFeedback {
  const identity = score.judgment_id ? `${score.key}.${score.judgment_id}` : score.key;
  if (score.status === "unavailable") return { key: boundedKey(identity), value: "unavailable" };
  if (score.status === "not_applicable") return { key: boundedKey(identity), value: "not_applicable" };
  return {
    key: boundedKey(identity),
    ...(score.score !== undefined ? { score: score.score } : {}),
    ...(score.value !== undefined ? { value: score.value } : {}),
  };
}

export function summaryFeedback(value: UbEvalExportV1): LangSmithFeedback[] {
  return Object.entries(value.summary).map(([key, item]) => ({
    key: boundedKey(key),
    ...(typeof item === "number" ? { score: item } : { value: item === null ? "unavailable" : item }),
  }));
}
