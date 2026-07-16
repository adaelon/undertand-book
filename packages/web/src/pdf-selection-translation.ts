import { ref } from "vue";
import { ApiError } from "./api";
import type {
  SelectionContext,
  SelectionTranslationRequest,
  SelectionTranslationResponse,
} from "./api";

export interface PdfSelectionTranslationDraft extends SelectionContext {
  request_id: string;
}

export type PdfSelectionTranslationPhase = "idle" | "loading" | "ready" | "error";
export type PdfSelectionTranslationInvalidation =
  | "close"
  | "selection"
  | "existing-action"
  | "book-switch"
  | "viewport"
  | "unmount";

export interface PdfSelectionTranslationError {
  message: string;
  error_code: string;
  category: string;
}

export interface PdfSelectionTranslationState {
  phase: PdfSelectionTranslationPhase;
  draft: PdfSelectionTranslationDraft | null;
  translation_markdown: string | null;
  error: PdfSelectionTranslationError | null;
}

const idleState = (): PdfSelectionTranslationState => ({
  phase: "idle",
  draft: null,
  translation_markdown: null,
  error: null,
});

function requestOf(draft: PdfSelectionTranslationDraft): SelectionTranslationRequest {
  return {
    status: draft.status,
    raw_quote: draft.raw_quote,
    resolved_quote: draft.resolved_quote,
    ranges: draft.ranges,
  };
}

function translationError(error: unknown): PdfSelectionTranslationError {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      error_code: error.errorCode,
      category: error.category,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    error_code: "TRANSLATION_REQUEST_FAILED",
    category: "internal",
  };
}

export function usePdfSelectionTranslation(
  translate: (request: SelectionTranslationRequest) => Promise<SelectionTranslationResponse>,
) {
  const state = ref<PdfSelectionTranslationState>(idleState());
  let sequence = 0;

  async function start(draft: PdfSelectionTranslationDraft) {
    const requestSequence = ++sequence;
    state.value = {
      phase: "loading",
      draft,
      translation_markdown: null,
      error: null,
    };
    try {
      const response = await translate(requestOf(draft));
      if (requestSequence !== sequence || state.value.draft?.request_id !== draft.request_id) return;
      state.value = {
        phase: "ready",
        draft,
        translation_markdown: response.translation_markdown,
        error: null,
      };
    } catch (error) {
      if (requestSequence !== sequence || state.value.draft?.request_id !== draft.request_id) return;
      state.value = {
        phase: "error",
        draft,
        translation_markdown: null,
        error: translationError(error),
      };
    }
  }

  function retry() {
    const draft = state.value.draft;
    if (!draft || state.value.phase !== "error") return Promise.resolve();
    return start(draft);
  }

  function invalidate(_reason: PdfSelectionTranslationInvalidation) {
    sequence += 1;
    state.value = idleState();
  }

  return {
    state,
    start,
    retry,
    invalidate,
  };
}
