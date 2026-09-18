export type WorkspaceMode = "single" | "compare" | "wide";
export type DisplayPreference = "auto" | "focus" | "compare";
export type WorkspaceRegion = "outline" | "reader" | "assistant";
export type WorkspaceNavigation = "bottom" | "compact" | "desktop";

export const WORKSPACE_LIMITS = Object.freeze({
  readerMinWidth: 400,
  assistantMinWidth: 320,
  compareGap: 12,
  compareMinHeight: 200,
  wideMinWidth: 1024,
  wideMinHeight: 420,
  keyboardHeightLoss: 120,
  inputPriorityMaxHeight: 420,
});

export const DEFAULT_WORKSPACE_SLOT_REGISTRY: Readonly<Record<string, WorkspaceRegion>> = Object.freeze({
  "technical.structure_map": "outline",
  "technical.agent": "assistant",
  "paper.structure_map": "outline",
  "paper.agent": "assistant",
});

export interface WorkspaceLogicalState {
  contextKey: string;
  revision: string | number | bigint;
  activePreset: string | null;
  openSlots: readonly string[];
  focusedSlot: string | null;
}

export interface WorkspaceViewport {
  containerWidth: number;
  containerHeight: number;
  visualWidth: number;
  visualHeight: number;
  offsetTop: number;
  offsetLeft: number;
  scale: number;
}

export interface WorkspaceInteraction {
  foreground: Exclude<WorkspaceRegion, "outline">;
  compareIntent: boolean;
  inputFocused: boolean;
  composing: boolean;
  selectionActive: boolean;
  expanded: boolean;
  lastHandledFocusKey: string | null;
}

export interface DeferredWorkspaceFocus {
  target: WorkspaceRegion;
  logicalRevision: string;
  requestKey: string;
}

export interface WorkspaceProjection {
  mode: WorkspaceMode;
  foreground: Exclude<WorkspaceRegion, "outline">;
  visibleRegions: WorkspaceRegion[];
  inputPriority: boolean;
  navigation: WorkspaceNavigation;
  deferredFocus: DeferredWorkspaceFocus | null;
  appliedFocusKey: string | null;
  unavailableFocus: string | null;
  measurable: boolean;
}

function positiveFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function revisionText(value: WorkspaceLogicalState["revision"]): string {
  return typeof value === "bigint" ? value.toString(10) : String(value);
}

function focusKey(logical: WorkspaceLogicalState): string | null {
  if (!logical.focusedSlot) return null;
  return `${logical.contextKey}:${revisionText(logical.revision)}:${logical.focusedSlot}`;
}

function uniqueRegions(regions: readonly WorkspaceRegion[]): WorkspaceRegion[] {
  return [...new Set(regions)];
}

export function resolveWorkspace(
  logical: WorkspaceLogicalState,
  viewport: WorkspaceViewport,
  interaction: WorkspaceInteraction,
  preference: DisplayPreference,
  slotRegistry: Readonly<Record<string, WorkspaceRegion>> = DEFAULT_WORKSPACE_SLOT_REGISTRY,
): WorkspaceProjection {
  const containerWidth = positiveFinite(viewport.containerWidth);
  const containerHeight = positiveFinite(viewport.containerHeight);
  const visualHeight = positiveFinite(viewport.visualHeight) || containerHeight;
  const measurable = containerWidth > 0 && containerHeight > 0;
  let foreground = interaction.foreground;
  let deferredFocus: DeferredWorkspaceFocus | null = null;
  let appliedFocusKey: string | null = null;
  let unavailableFocus: string | null = null;

  const requestKey = focusKey(logical);
  if (requestKey && requestKey !== interaction.lastHandledFocusKey) {
    const target = slotRegistry[logical.focusedSlot!];
    if (!target) {
      unavailableFocus = logical.focusedSlot;
    } else if (target !== "outline") {
      if ((interaction.composing || interaction.selectionActive) && target !== foreground) {
        deferredFocus = {
          target,
          logicalRevision: revisionText(logical.revision),
          requestKey,
        };
      } else {
        foreground = target;
        appliedFocusKey = requestKey;
      }
    } else {
      appliedFocusKey = requestKey;
    }
  }

  const inputPriority = measurable
    && interaction.inputFocused
    && visualHeight <= WORKSPACE_LIMITS.inputPriorityMaxHeight
    && containerHeight - visualHeight >= WORKSPACE_LIMITS.keyboardHeightLoss;
  if (inputPriority) foreground = "assistant";

  if (!measurable || interaction.expanded || preference === "focus" || inputPriority) {
    return {
      mode: "single",
      foreground,
      visibleRegions: [foreground],
      inputPriority,
      navigation: inputPriority || (measurable && containerHeight < WORKSPACE_LIMITS.wideMinHeight)
        ? "compact"
        : "bottom",
      deferredFocus,
      appliedFocusKey,
      unavailableFocus,
      measurable,
    };
  }

  const openRegions = uniqueRegions(logical.openSlots.map((slot) => slotRegistry[slot]).filter(Boolean));
  const canUseWide = containerWidth >= WORKSPACE_LIMITS.wideMinWidth
    && containerHeight >= WORKSPACE_LIMITS.wideMinHeight;
  if (canUseWide) {
    return {
      mode: "wide",
      foreground,
      visibleRegions: uniqueRegions([
        ...(openRegions.includes("outline") ? ["outline" as const] : []),
        "reader",
        ...(openRegions.includes("assistant") ? ["assistant" as const] : []),
      ]),
      inputPriority: false,
      navigation: "desktop",
      deferredFocus,
      appliedFocusKey,
      unavailableFocus,
      measurable: true,
    };
  }

  const compareWidth = WORKSPACE_LIMITS.readerMinWidth
    + WORKSPACE_LIMITS.compareGap
    + WORKSPACE_LIMITS.assistantMinWidth;
  const wantsCompare = preference === "compare" || interaction.compareIntent;
  if (wantsCompare
      && containerWidth >= compareWidth
      && containerHeight >= WORKSPACE_LIMITS.compareMinHeight) {
    return {
      mode: "compare",
      foreground,
      visibleRegions: ["reader", "assistant"],
      inputPriority: false,
      navigation: containerHeight < WORKSPACE_LIMITS.wideMinHeight ? "compact" : "bottom",
      deferredFocus,
      appliedFocusKey,
      unavailableFocus,
      measurable: true,
    };
  }

  return {
    mode: "single",
    foreground,
    visibleRegions: [foreground],
    inputPriority: false,
    navigation: containerHeight < WORKSPACE_LIMITS.wideMinHeight ? "compact" : "bottom",
    deferredFocus,
    appliedFocusKey,
    unavailableFocus,
    measurable: true,
  };
}
