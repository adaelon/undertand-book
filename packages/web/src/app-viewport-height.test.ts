// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_VIEWPORT_HEIGHT_PROPERTY,
  installAppViewportHeightFallback,
  resolveLegacyAppViewportHeight,
} from "./app-viewport-height";

class FakeVisualViewport extends EventTarget {
  width = 390;
  height = 760;
  offsetTop = 0;
  offsetLeft = 0;
  pageTop = 0;
  pageLeft = 0;
  scale = 1;
}

afterEach(() => {
  document.documentElement.style.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
});

describe("legacy app viewport height", () => {
  it("leaves dynamic viewport sizing to CSS when dvh is supported", () => {
    expect(resolveLegacyAppViewportHeight({
      supportsDynamicViewport: true,
      innerHeight: 844,
      visualHeight: 760,
      scale: 1,
    })).toBeNull();
  });

  it("uses the unobscured visual height when a legacy toolbar covers 100vh", () => {
    expect(resolveLegacyAppViewportHeight({
      supportsDynamicViewport: false,
      innerHeight: 844,
      visualHeight: 760,
      scale: 1,
    })).toBe(760);
  });

  it("does not shrink the app layout in response to pinch zoom", () => {
    expect(resolveLegacyAppViewportHeight({
      supportsDynamicViewport: false,
      innerHeight: 844,
      visualHeight: 422,
      scale: 2,
    })).toBe(844);
  });

  it("updates the CSS height when a legacy visual viewport changes", () => {
    const visualViewport = new FakeVisualViewport();
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visualViewport });

    const stop = installAppViewportHeightFallback(window, document, false);
    expect(document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY)).toBe("760px");

    visualViewport.height = 700;
    visualViewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY)).toBe("700px");

    stop();
    expect(document.documentElement.style.getPropertyValue(APP_VIEWPORT_HEIGHT_PROPERTY)).toBe("");
  });
});
