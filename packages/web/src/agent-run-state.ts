import type { AgentAnswerView } from "./generated/AgentAnswerView";
import type { RunActivity } from "./generated/RunActivity";
import type { AgentEffect, ReaderState, AgentChatTurn } from "./api";
export type { RunActivity };

export interface RunDescriptor { book_id: string; session_id: string; turn_id: string }
export interface AnswerDraft { message_id: number; revision: number; operation: string; view: AgentAnswerView | null }
export interface RunSnapshot {
  reader_state?: ReaderState | null;
  effects?: { effect_id: string; effect: AgentEffect }[];
  draft?: AnswerDraft | null;
  descriptor: RunDescriptor;
  last_seq: number;
  execution_state: "running" | "cancelling" | "finalizing" | "completed" | "failed" | "cancelled" | "ended" | "interrupted";
  persistence_state: "pending" | "saved" | "failed";
  activities: RunActivity[];
  final_view: AgentChatTurn | null;
  error: { error_code: string; category: string; message: string } | null;
}
export interface RunEvent { turn_id: string; seq: number; elapsed_ms: number; type: string; payload: unknown }
export function initialRun(descriptor: RunDescriptor): RunSnapshot {
  return { descriptor, last_seq: -1, execution_state: "running", persistence_state: "pending", activities: [], final_view: null, error: null };
}
export function interruptRun(
  state: RunSnapshot,
  error: NonNullable<RunSnapshot["error"]>,
): RunSnapshot {
  return {
    ...state,
    execution_state: "interrupted",
    persistence_state: "failed",
    error,
  };
}
export function reduceRun(state: RunSnapshot, event: RunEvent): RunSnapshot {
  if (event.turn_id !== state.descriptor.turn_id || event.seq <= state.last_seq) return state;
  if (event.type === "run.snapshot" || ["run.completed", "run.failed", "run.cancelled", "run.persistence_failed"].includes(event.type)) {
    const snapshot = event.payload as RunSnapshot;
    if (snapshot.descriptor.book_id !== state.descriptor.book_id || snapshot.descriptor.session_id !== state.descriptor.session_id || snapshot.descriptor.turn_id !== state.descriptor.turn_id) return state;
    return { ...snapshot, last_seq: event.seq };
  }
  const next = { ...state, last_seq: event.seq };
  if (event.type === "reader.changed") {
    const reader = event.payload as ReaderState;
    if (reader.book_id === state.descriptor.book_id && reader.revision >= (state.reader_state?.revision ?? -1)) next.reader_state = reader;
  }
  if (event.type === "effect.created") {
    const effect = event.payload as { effect_id: string; effect: AgentEffect };
    if (!state.effects?.some(old => old.effect_id === effect.effect_id)) next.effects = [...(state.effects ?? []), effect];
  }
  if (event.type === "answer.patch") {
    const patch = event.payload as AnswerDraft;
    const previous = state.draft;
    if (!previous || patch.message_id > previous.message_id || (patch.message_id === previous.message_id && patch.revision >= previous.revision)) {
      if (patch.operation === "append") {
        if (previous?.message_id === patch.message_id && previous.revision === patch.revision && previous.view && patch.view) {
          const parts = previous.view.parts.map(part => ({ ...part }));
          for (const part of patch.view.parts) {
            const last = parts.at(-1);
            if (last?.kind === "markdown" && part.kind === "markdown") last.text += part.text;
            else parts.push({ ...part });
          }
          const sources = [...previous.view.sources];
          for (const source of patch.view.sources) if (!sources.some(old => old.source_ref_id === source.source_ref_id)) sources.push(source);
          next.draft = { ...patch, operation: "replace", view: { parts, sources } };
        }
      } else next.draft = patch;
    }
  }
  if (event.type === "run.cancelling") next.execution_state = "cancelling";
  if (event.type === "run.finalizing") next.execution_state = "finalizing";
  if (/^(model|tool)\.(started|finished)$/.test(event.type)) {
    const activity = event.payload as RunActivity;
    next.activities = [...state.activities];
    const index = next.activities.findIndex((old) => old.step_id === activity.step_id);
    if (index < 0) next.activities.push(activity); else next.activities[index] = activity;
    next.activities.sort((a, b) => a.step_id - b.step_id);
  }
  return next;
}
export function runStatusText(snapshot: RunSnapshot, connection: string): string {
  if (snapshot.error?.error_code === "AGENT_RUN_NOT_FOUND") return "无法核对原运行；问题不会自动重提";
  if (connection === "authentication") return "认证已失效；请通过现有受保护入口恢复登录";
  if (connection === "offline") return "暂时无法核对运行；问题不会自动重提";
  if (snapshot.persistence_state === "failed") return "运行已结束，但结果未保存";
  if (snapshot.execution_state === "cancelled") return "已停止";
  if (snapshot.execution_state === "failed") return "运行失败";
  if (snapshot.execution_state === "completed") return "运行已结束";
  if (snapshot.execution_state === "cancelling") return "正在停止，等待当前请求退出";
  if (snapshot.execution_state === "finalizing") return "正在保存结果";
  if (connection === "reconnecting") return "连接中断，正在恢复活动";
  return "正在运行";
}
