// @vitest-environment happy-dom
// @vitest-environment-options {"happyDOM":{"settings":{"disableCSSFileLoading":true}}}
import { describe, expect, it } from "vitest";
import { presentationDocument } from "./presentation-document";
import type { PresentationView } from "./generated/PresentationView";

function view(): PresentationView {
  return { restored_state: null, restored_state_revision: null, reference: { presentation_id: "p", revision: 2 }, title: "Recall", entrypoint: "page/index.html",
    content_files: { "page/index.html": '<link rel="stylesheet" href="../style.css"><h1>Recall</h1><script src="../main.js"></script><img src="../diagram.svg">',
      "style.css": ".card { padding: 8px; }", "main.js": "window.count = 2;", "diagram.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    readable_view: { parts: [{ kind: "markdown", text: "Recall" }], sources: [] }, sources: [], assumptions: [], initial_state: { count: 2 } };
}
describe("presentation document", () => {
  it("bundles the exact version's local assets, common style, initial values and isolated bridge", () => {
    const output = presentationDocument(view());
    const doc = new DOMParser().parseFromString(output, "text/html");
    expect(doc.querySelector("script[src]")).toBeNull();
    expect(doc.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(doc.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
    expect(output).toContain("window.count = 2;");
    expect(output).toContain('"initialState":{"count":2}');
    expect(doc.head.firstElementChild?.getAttribute("content")).toContain("connect-src 'none'");
    expect(doc.documentElement.hasAttribute("data-presentation-pending")).toBe(true);
  });
  it("reports missing and external assets instead of silently rendering a partial page", () => {
    const missing = view(); delete missing.content_files["main.js"];
    expect(() => presentationDocument(missing)).toThrow("内容资源缺失");
    const external = view(); external.content_files["page/index.html"] = '<script src="https://example.com/app.js"></script>';
    expect(() => presentationDocument(external)).toThrow("版本内的本地资源");
  });
});
