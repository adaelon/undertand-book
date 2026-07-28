// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { resolveMarkdownNotePlacementTarget } from "./markdown-note-placement";

function pointerAt(target: Element): PointerEvent {
  let captured: PointerEvent | null = null;
  const root = target.closest("#root")!;
  root.addEventListener("pointerup", (event) => { captured = event as PointerEvent; }, { once: true });
  target.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  if (!captured) throw new Error("pointer event was not captured");
  return captured;
}

describe("resolveMarkdownNotePlacementTarget", () => {
  it("accepts only a real current body data-lid from the PointerEvent target", () => {
    document.body.innerHTML = `
      <main id="root">
        <p data-lid="1.1"><span id="text">body</span></p>
        <p data-lid="9.9"><span id="stale">stale</span></p>
        <div id="blank"></div>
      </main>
    `;
    const root = document.querySelector<HTMLElement>("#root")!;
    const validLids = new Set(["1.1"]);

    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#text")!), root, validLids))
      .toEqual({ lid: "1.1" });
    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#stale")!), root, validLids))
      .toBeNull();
    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#blank")!), root, validLids))
      .toBeNull();
  });

  it("rejects NoteCard and controls even when nested under a body block", () => {
    document.body.innerHTML = `
      <main id="root">
        <section data-lid="2.1">
          <span id="body">body</span>
          <article class="note-card"><span id="note">note</span></article>
          <div class="block-actions"><button id="action">action</button></div>
          <button class="formula-open" id="formula">formula body</button>
        </section>
      </main>
    `;
    const root = document.querySelector<HTMLElement>("#root")!;
    const validLids = new Set(["2.1"]);

    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#note")!), root, validLids))
      .toBeNull();
    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#action")!), root, validLids))
      .toBeNull();
    expect(resolveMarkdownNotePlacementTarget(pointerAt(document.querySelector("#formula")!), root, validLids))
      .toEqual({ lid: "2.1" });
  });
});
