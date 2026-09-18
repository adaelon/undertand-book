import { onBeforeUnmount, onMounted, ref, watch, type Ref } from "vue";
import type { WorkspaceViewport } from "./workspace-layout";

export const EMPTY_VIEWPORT_ENVIRONMENT: WorkspaceViewport = Object.freeze({
  containerWidth: 0,
  containerHeight: 0,
  visualWidth: 0,
  visualHeight: 0,
  offsetTop: 0,
  offsetLeft: 0,
  scale: 1,
});

type VisualViewportLike = Pick<VisualViewport,
  "width" | "height" | "offsetTop" | "offsetLeft" | "scale">;

export function measureViewportEnvironment(
  root: HTMLElement | null,
  visualViewport: VisualViewportLike | null | undefined,
): WorkspaceViewport {
  if (!root) return { ...EMPTY_VIEWPORT_ENVIRONMENT };
  const rect = root.getBoundingClientRect();
  const containerWidth = Math.max(0, root.clientWidth || rect.width || 0);
  const containerHeight = Math.max(0, root.clientHeight || rect.height || 0);
  return {
    containerWidth,
    containerHeight,
    visualWidth: Math.max(0, visualViewport?.width ?? containerWidth),
    visualHeight: Math.max(0, visualViewport?.height ?? containerHeight),
    offsetTop: visualViewport?.offsetTop ?? 0,
    offsetLeft: visualViewport?.offsetLeft ?? 0,
    scale: visualViewport?.scale && visualViewport.scale > 0 ? visualViewport.scale : 1,
  };
}

export function isWorkspaceInput(target: EventTarget | null, root: HTMLElement | null): boolean {
  return target instanceof HTMLElement
    && !!root?.contains(target)
    && !!target.closest("[data-workspace-input]");
}

export function useViewportEnvironment(root: Ref<HTMLElement | null>) {
  const environment = ref<WorkspaceViewport>({ ...EMPTY_VIEWPORT_ENVIRONMENT });
  const inputFocused = ref(false);
  const composing = ref(false);
  let iframeEditing = false;
  let observer: ResizeObserver | null = null;
  let observedRoot: HTMLElement | null = null;

  const update = () => {
    environment.value = measureViewportEnvironment(root.value, window.visualViewport);
  };
  const onFocusIn = (event: FocusEvent) => {
    if (isWorkspaceInput(event.target, root.value)) inputFocused.value = true;
  };
  const onFocusOut = () => {
    queueMicrotask(() => {
      inputFocused.value = iframeEditing || isWorkspaceInput(document.activeElement, root.value);
      if (!inputFocused.value) composing.value = false;
    });
  };
  const onIframeEditing = (event: Event) => {
    const custom = event as CustomEvent<{ editing?: unknown }>;
    if (!(event.target instanceof Node) || !root.value?.contains(event.target)) return;
    if (typeof custom.detail?.editing !== "boolean") return;
    iframeEditing = custom.detail.editing;
    inputFocused.value = iframeEditing || isWorkspaceInput(document.activeElement, root.value);
    if (!inputFocused.value) composing.value = false;
  };
  const onCompositionStart = (event: CompositionEvent) => {
    if (isWorkspaceInput(event.target, root.value)) composing.value = true;
  };
  const onCompositionEnd = (event: CompositionEvent) => {
    if (isWorkspaceInput(event.target, root.value)) composing.value = false;
  };

  function observe(next: HTMLElement | null) {
    if (observer && observedRoot) observer.unobserve(observedRoot);
    if (observedRoot !== next) iframeEditing = false;
    observedRoot = next;
    if (observer && next) observer.observe(next);
    update();
  }

  onMounted(() => {
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(update);
    }
    observe(root.value);
    window.addEventListener("resize", update, { passive: true });
    window.visualViewport?.addEventListener("resize", update, { passive: true });
    window.visualViewport?.addEventListener("scroll", update, { passive: true });
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("compositionstart", onCompositionStart);
    document.addEventListener("compositionend", onCompositionEnd);
    document.addEventListener("workspace-iframe-editing", onIframeEditing);
  });
  watch(root, observe);

  onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
    observedRoot = null;
    window.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("resize", update);
    window.visualViewport?.removeEventListener("scroll", update);
    document.removeEventListener("focusin", onFocusIn);
    document.removeEventListener("focusout", onFocusOut);
    document.removeEventListener("compositionstart", onCompositionStart);
    document.removeEventListener("compositionend", onCompositionEnd);
    document.removeEventListener("workspace-iframe-editing", onIframeEditing);
  });

  return { environment, inputFocused, composing, update };
}
