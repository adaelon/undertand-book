import { ref } from "vue";
import type {
  PdfSelectionResolveResponse,
  SelectionContext,
} from "./api";

export interface PdfSelectionCapture {
  request_id: string;
  raw_quote: string;
  rects: Array<{ pageIndex: number; bbox: [number, number, number, number] }>;
  screen_rect: { left: number; top: number; right: number; bottom: number };
}

export interface PdfSelectionDraft extends SelectionContext {
  request_id: string;
  screen_rect: PdfSelectionCapture["screen_rect"];
}

export type PdfSelectionPhase = "idle" | "resolving" | "ready" | "saving" | "error";

export interface PdfSelectionState {
  phase: PdfSelectionPhase;
  capture: PdfSelectionCapture | null;
  draft: PdfSelectionDraft | null;
  error: string | null;
}

const idleState = (): PdfSelectionState => ({
  phase: "idle",
  capture: null,
  draft: null,
  error: null,
});

export function usePdfSelectionDraft(
  resolve: (capture: PdfSelectionCapture) => Promise<PdfSelectionResolveResponse>,
) {
  const state = ref<PdfSelectionState>(idleState());
  let currentRequestId = "";

  async function resolveCapture(capture: PdfSelectionCapture) {
    currentRequestId = capture.request_id;
    state.value = { phase: "resolving", capture, draft: null, error: null };
    try {
      const response = await resolve(capture);
      if (currentRequestId !== capture.request_id) return;
      if (response.status === "unresolved" || response.ranges.length === 0) {
        state.value = idleState();
        return;
      }
      state.value = {
        phase: "ready",
        capture,
        draft: {
          request_id: capture.request_id,
          status: response.status,
          ...(response.resolution_basis ? { resolution_basis: response.resolution_basis } : {}),
          raw_quote: capture.raw_quote,
          resolved_quote: response.quote_markdown,
          ranges: response.ranges.map((selected) => ({
            lid: selected.lid,
            range: selected.range,
          })),
          screen_rect: capture.screen_rect,
        },
        error: null,
      };
    } catch (error) {
      if (currentRequestId !== capture.request_id) return;
      state.value = {
        phase: "error",
        capture,
        draft: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function retry() {
    const capture = state.value.capture;
    if (!capture || state.value.phase !== "error") return Promise.resolve();
    return resolveCapture(capture);
  }

  function beginAction(): PdfSelectionDraft | null {
    if (state.value.phase !== "ready" || !state.value.draft) return null;
    state.value = { ...state.value, phase: "saving", error: null };
    return state.value.draft;
  }

  function actionFailed(error: unknown) {
    if (!state.value.draft) return;
    state.value = {
      ...state.value,
      phase: "ready",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  function cancel() {
    currentRequestId = "";
    state.value = idleState();
  }

  return {
    state,
    capture: resolveCapture,
    retry,
    beginAction,
    actionFailed,
    complete: cancel,
    cancel,
  };
}
