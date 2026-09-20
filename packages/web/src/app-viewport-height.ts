export const APP_VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";

export interface AppViewportHeightMeasurement {
  supportsDynamicViewport: boolean;
  innerHeight: number;
  visualHeight?: number | null;
  scale?: number | null;
}

function positiveFinite(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function resolveLegacyAppViewportHeight(
  measurement: AppViewportHeightMeasurement,
): number | null {
  if (measurement.supportsDynamicViewport) return null;

  const innerHeight = positiveFinite(measurement.innerHeight);
  const visualHeight = positiveFinite(measurement.visualHeight);
  const scale = positiveFinite(measurement.scale) || 1;
  if (!visualHeight) return innerHeight || null;

  const unscaledVisualHeight = visualHeight * scale;
  return innerHeight ? Math.min(innerHeight, unscaledVisualHeight) : unscaledVisualHeight;
}

export function installAppViewportHeightFallback(
  targetWindow: Window = window,
  targetDocument: Document = document,
  supportsDynamicViewport = typeof CSS !== "undefined" && CSS.supports("height", "100dvh"),
): () => void {
  const rootStyle = targetDocument.documentElement.style;
  if (supportsDynamicViewport) {
    rootStyle.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
    return () => {};
  }

  const update = () => {
    const visualViewport = targetWindow.visualViewport;
    const height = resolveLegacyAppViewportHeight({
      supportsDynamicViewport: false,
      innerHeight: targetWindow.innerHeight,
      visualHeight: visualViewport?.height,
      scale: visualViewport?.scale,
    });
    if (height) rootStyle.setProperty(APP_VIEWPORT_HEIGHT_PROPERTY, `${height}px`);
    else rootStyle.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
  };

  const visualViewport = targetWindow.visualViewport;
  update();
  targetWindow.addEventListener("resize", update, { passive: true });
  visualViewport?.addEventListener("resize", update, { passive: true });
  visualViewport?.addEventListener("scroll", update, { passive: true });

  return () => {
    targetWindow.removeEventListener("resize", update);
    visualViewport?.removeEventListener("resize", update);
    visualViewport?.removeEventListener("scroll", update);
    rootStyle.removeProperty(APP_VIEWPORT_HEIGHT_PROPERTY);
  };
}
