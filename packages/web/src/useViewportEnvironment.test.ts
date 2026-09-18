// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isWorkspaceInput, measureViewportEnvironment } from "./useViewportEnvironment";

describe("viewport environment", () => {
  it("measures the content box and keeps visual offset/scale separate", () => {
    const root = document.createElement("section");
    Object.defineProperty(root, "clientWidth", { value: 390 });
    Object.defineProperty(root, "clientHeight", { value: 844 });
    root.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844,
      width: 390, height: 844, toJSON: () => ({}),
    });
    expect(measureViewportEnvironment(root, {
      width: 390,
      height: 390,
      offsetTop: 210,
      offsetLeft: 0,
      scale: 1.5,
    })).toEqual({
      containerWidth: 390,
      containerHeight: 844,
      visualWidth: 390,
      visualHeight: 390,
      offsetTop: 210,
      offsetLeft: 0,
      scale: 1.5,
    });
  });

  it("recognizes only explicitly marked workspace inputs", () => {
    const root = document.createElement("section");
    const marked = document.createElement("textarea");
    marked.dataset.workspaceInput = "agent";
    const plain = document.createElement("input");
    root.append(marked, plain);
    expect(isWorkspaceInput(marked, root)).toBe(true);
    expect(isWorkspaceInput(plain, root)).toBe(false);
    expect(isWorkspaceInput(marked, document.createElement("section"))).toBe(false);
  });
});
