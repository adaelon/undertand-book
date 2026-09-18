import { onBeforeUnmount, onMounted, type Ref } from "vue";

export interface ReaderSelectionRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ReaderSelectionSnapshot {
  range: Range;
  rect: ReaderSelectionRect;
  text: string;
  signature: string;
}

function selectionNodeElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
}

function isEditableSelection(node: Node): boolean {
  return !!selectionNodeElement(node)?.closest("input, textarea, select, [contenteditable='true'], [data-reader-selection-ignore]");
}

function boundarySignature(node: Node, offset: number): string {
  const element = selectionNodeElement(node)?.closest<HTMLElement>("[data-lid]");
  return `${element?.dataset.lid ?? "reader"}:${offset}`;
}

export function readReaderSelection(
  root: HTMLElement,
  selection: Selection | null = window.getSelection(),
): ReaderSelectionSnapshot | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const liveRange = selection.getRangeAt(0);
  if (!root.contains(liveRange.startContainer) || !root.contains(liveRange.endContainer)) return null;
  if (isEditableSelection(liveRange.startContainer) || isEditableSelection(liveRange.endContainer)) return null;

  const range = liveRange.cloneRange();
  const text = range.toString();
  if (!text.trim()) return null;
  const rect = range.getBoundingClientRect();
  const signature = [
    boundarySignature(range.startContainer, range.startOffset),
    boundarySignature(range.endContainer, range.endOffset),
    text,
  ].join("|");
  return {
    range,
    text,
    signature,
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
  };
}

export function useReaderSelection(
  root: Ref<HTMLElement | null>,
  onSelection: (snapshot: ReaderSelectionSnapshot | null) => void,
) {
  let scheduled = false;
  let lastSignature: string | null = null;

  const capture = () => {
    scheduled = false;
    const element = root.value;
    const selection = window.getSelection();
    if (!element || !selection) return;

    if (selection.isCollapsed) {
      if (selection.anchorNode && element.contains(selection.anchorNode) && lastSignature !== null) {
        lastSignature = null;
        onSelection(null);
      }
      return;
    }

    const snapshot = readReaderSelection(element, selection);
    if (!snapshot || snapshot.signature === lastSignature) return;
    lastSignature = snapshot.signature;
    onSelection(snapshot);
  };

  const scheduleCapture = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(capture);
  };

  onMounted(() => {
    document.addEventListener("selectionchange", scheduleCapture);
    root.value?.addEventListener("pointerup", scheduleCapture);
    root.value?.addEventListener("keyup", scheduleCapture);
  });

  onBeforeUnmount(() => {
    document.removeEventListener("selectionchange", scheduleCapture);
    root.value?.removeEventListener("pointerup", scheduleCapture);
    root.value?.removeEventListener("keyup", scheduleCapture);
  });

  return { capture: scheduleCapture };
}
