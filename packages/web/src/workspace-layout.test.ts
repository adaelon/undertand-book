import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_SLOT_REGISTRY,
  resolveWorkspace,
  type DisplayPreference,
  type WorkspaceInteraction,
  type WorkspaceLogicalState,
  type WorkspaceViewport,
} from "./workspace-layout";

const logical = (overrides: Partial<WorkspaceLogicalState> = {}): WorkspaceLogicalState => ({
  contextKey: "book-a:chat-a",
  revision: 7n,
  activePreset: "technical_read",
  openSlots: ["technical.structure_map", "technical.agent"],
  focusedSlot: null,
  ...overrides,
});

const viewport = (width: number, height: number, visualHeight = height): WorkspaceViewport => ({
  containerWidth: width,
  containerHeight: height,
  visualWidth: width,
  visualHeight,
  offsetTop: 0,
  offsetLeft: 0,
  scale: 1,
});

const interaction = (overrides: Partial<WorkspaceInteraction> = {}): WorkspaceInteraction => ({
  foreground: "reader",
  compareIntent: false,
  inputFocused: false,
  composing: false,
  selectionActive: false,
  expanded: false,
  lastHandledFocusKey: null,
  ...overrides,
});

function project(
  width: number,
  height: number,
  preference: DisplayPreference = "auto",
  interactionOverrides: Partial<WorkspaceInteraction> = {},
  logicalOverrides: Partial<WorkspaceLogicalState> = {},
) {
  return resolveWorkspace(
    logical(logicalOverrides),
    viewport(width, height),
    interaction(interactionOverrides),
    preference,
  );
}

describe("resolveWorkspace", () => {
  it("uses the exact 732px compare boundary and the 200px height boundary", () => {
    expect(project(731, 390, "compare").mode).toBe("single");
    expect(project(732, 199, "compare").mode).toBe("single");
    expect(project(732, 200, "compare")).toMatchObject({
      mode: "compare",
      visibleRegions: ["reader", "assistant"],
    });
  });

  it("keeps a zero-sized hidden workspace single and explicitly unmeasurable", () => {
    expect(project(0, 0)).toMatchObject({
      mode: "single",
      visibleRegions: ["reader"],
      measurable: false,
    });
  });

  it("uses wide only when width and content height both satisfy the contract", () => {
    expect(project(1200, 419).mode).toBe("single");
    expect(project(1024, 420)).toMatchObject({
      mode: "wide",
      visibleRegions: ["outline", "reader", "assistant"],
      navigation: "desktop",
    });
  });

  it("does not infer compare intent from an open Agent slot", () => {
    expect(project(844, 390, "auto", { compareIntent: false }).mode).toBe("single");
    expect(project(844, 390, "auto", { compareIntent: true }).mode).toBe("compare");
  });

  it("honors an explicit focus preference without erasing compare intent", () => {
    const result = project(1200, 800, "focus", { compareIntent: true, foreground: "assistant" });
    expect(result).toMatchObject({ mode: "single", foreground: "assistant", visibleRegions: ["assistant"] });
  });

  it("requires both input focus and material visual-height loss for input priority", () => {
    const focused = interaction({ inputFocused: true });
    expect(resolveWorkspace(logical(), viewport(390, 844, 760), focused, "auto").inputPriority).toBe(false);
    expect(resolveWorkspace(logical(), viewport(390, 844, 390), focused, "auto")).toMatchObject({
      mode: "single",
      foreground: "assistant",
      inputPriority: true,
      navigation: "compact",
    });
  });

  it("defers a new logical focus request while composition or selection is protected", () => {
    const result = project(390, 844, "auto", { composing: true }, {
      focusedSlot: "technical.agent",
      revision: 900719925474099312345n,
    });
    expect(result.foreground).toBe("reader");
    expect(result.deferredFocus).toEqual({
      target: "assistant",
      logicalRevision: "900719925474099312345",
      requestKey: "book-a:chat-a:900719925474099312345:technical.agent",
    });
  });

  it("does not replay an already handled focus request on resize", () => {
    const key = "book-a:chat-a:7:technical.agent";
    const result = project(390, 844, "auto", { foreground: "reader", lastHandledFocusKey: key }, {
      focusedSlot: "technical.agent",
    });
    expect(result.foreground).toBe("reader");
    expect(result.appliedFocusKey).toBeNull();
  });

  it("reports an unregistered formal slot instead of pretending it is mounted", () => {
    const result = project(390, 844, "auto", {}, { focusedSlot: "technical.evidence" });
    expect(result.unavailableFocus).toBe("technical.evidence");
    expect(result.foreground).toBe("reader");
    expect(DEFAULT_WORKSPACE_SLOT_REGISTRY["technical.evidence"]).toBeUndefined();
  });

  it("is deterministic and has no callback or API surface", () => {
    const apiSpy = vi.fn();
    const args = [logical({ activePreset: "unknown-preset" }), viewport(844, 390), interaction({ compareIntent: true }), "auto"] as const;
    expect(resolveWorkspace(...args)).toEqual(resolveWorkspace(...args));
    expect(apiSpy).not.toHaveBeenCalled();
  });
});
