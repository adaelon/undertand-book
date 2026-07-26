import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

function success(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("source manifest API compatibility", () => {
  it("treats a legacy technical-book manifest as no PDF runtime manifest", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => success({
      book_id: "legacy-technical-book",
      canonical_source: {
        kind: "markdown",
        path: "legacy.md",
        truth_file: "source.txt",
        participates_in_lid: true,
        citation_anchor: "lid",
      },
      attachments: [],
    })));

    await expect(api.sourceManifest()).resolves.toBeNull();
  });

  it("preserves a valid v2 PDF runtime manifest", async () => {
    const manifest = {
      version: "source_manifest.v2",
      book_id: "paper-a",
      canonical_source: {
        kind: "reconciled_markdown",
        path: "source.txt",
        citation_anchor: "lid",
        sha256: "source-hash",
      },
      original_pdf: {
        path: "paper.pdf",
        sha256: "pdf-hash",
        citation_anchor: false,
      },
      capabilities: {
        view_pdf: { status: "available" },
        project_lid_to_pdf: { status: "degraded", reason: "line fallback" },
        resolve_pdf_selection: { status: "available" },
        project_ranges_to_pdf: { status: "degraded", reason: "line fallback" },
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => success(manifest)));

    await expect(api.sourceManifest()).resolves.toEqual(manifest);
  });
});
