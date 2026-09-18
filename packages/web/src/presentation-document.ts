import type { PresentationView } from "./generated/PresentationView";
import commonStyle from "./presentation.css?raw";
import bridge from "./presentation-bridge.js?raw";

/** Assemble private logical assets into one opaque-origin document; no host URL is exposed. */
export function presentationDocument(view: PresentationView): string {
  const doc = new DOMParser().parseFromString(view.content_files[view.entrypoint] ?? "", "text/html");
  const asset = (path: string) => {
    const base = new URL(view.entrypoint, "https://presentation.invalid/");
    const url = new URL(path, base);
    if (url.origin !== base.origin || url.search || url.hash) throw new Error("内容只能使用版本内的本地资源。");
    const value = view.content_files[decodeURIComponent(url.pathname.slice(1))];
    if (value === undefined) throw new Error("内容资源缺失。");
    return value;
  };
  doc.querySelectorAll("base, meta[http-equiv]").forEach(node => node.remove());
  doc.querySelectorAll<HTMLScriptElement>("script[src]").forEach(node => {
    node.textContent = asset(node.getAttribute("src")!); node.removeAttribute("src");
  });
  doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach(node => {
    const style = doc.createElement("style"); style.textContent = asset(node.getAttribute("href")!); node.replaceWith(style);
  });
  doc.querySelectorAll<HTMLImageElement>("img[src]").forEach(node => {
    const src = node.getAttribute("src")!;
    if (!src.startsWith("data:")) node.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset(src))}`;
  });
  const policy = doc.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'";
  const style = doc.createElement("style"); style.textContent = commonStyle;
  const script = doc.createElement("script");
  // JSON escaping protects the script element, not the generated page from its own code.
  const data = JSON.stringify({ sources: view.sources, initialState: view.initial_state, restoredState: view.restored_state }).replaceAll("<", "\\u003c");
  script.textContent = `(${bridge.trim()})(${data});`;
  doc.head.prepend(policy, style, script);
  doc.documentElement.setAttribute("data-presentation-pending", "");
  return "<!doctype html>" + doc.documentElement.outerHTML;
}
