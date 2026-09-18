import { describe, expect, it } from "vitest";
import { resolvePresentationEditingMessage } from "./presentation-host";

describe("presentation host editing focus", () => {
  it("accepts only the current visible and actually focused frame", () => {
    const message = { kind: "editing-focus", generation: 4, editing: true };
    expect(resolvePresentationEditingMessage(message, { generation: 4, frameFocused: true, visible: true })).toBe(true);
    expect(resolvePresentationEditingMessage(message, { generation: 5, frameFocused: true, visible: true })).toBeNull();
    expect(resolvePresentationEditingMessage(message, { generation: 4, frameFocused: false, visible: true })).toBe(false);
    expect(resolvePresentationEditingMessage(message, { generation: 4, frameFocused: true, visible: false })).toBe(false);
  });

  it("clears a current editing hint without requiring the frame to stay focused", () => {
    expect(resolvePresentationEditingMessage(
      { kind: "editing-focus", generation: 4, editing: false },
      { generation: 4, frameFocused: false, visible: true },
    )).toBe(false);
  });
});
