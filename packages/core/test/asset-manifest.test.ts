import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { buildAssetManifest } from "../src/asset-manifest";
import { epubToSource } from "../src/epub-adapter";
import { markdownToBlocks } from "../src/md-adapter";
import { segment } from "../src/segment";
import { AssetManifestZ } from "../src/zod";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "understand-book-assets-"));
}

describe("asset manifest image collection", () => {
  it("copies Markdown image files into the book asset bundle", () => {
    const dir = tempDir();
    const imageDir = path.join(dir, "images");
    const imagePath = path.join(imageDir, "diagram.png");
    const mdPath = path.join(dir, "paper.md");
    const outDir = path.join(dir, "out");
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(imagePath, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
    writeFileSync(mdPath, "Intro.\n\n![Diagram](images/diagram.png)\n", "utf8");

    const source = readFileSync(mdPath, "utf8");
    const blocks = markdownToBlocks(source);
    const lidNodes = segment(blocks);
    const manifest = buildAssetManifest({
      book_id: "paper-a",
      book_path: mdPath,
      output_dir: outDir,
      source_blocks: blocks,
      lid_nodes: lidNodes,
    });

    expect(AssetManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.images).toHaveLength(1);
    expect(manifest.images[0]).toMatchObject({
      kind: "image",
      alt: "Diagram",
      original_src: "images/diagram.png",
      source: "markdown",
      status: "available",
      mime: "image/png",
      size_bytes: 7,
    });
    expect(manifest.images[0].stored_path).toMatch(/^assets\/images\/.+\.png$/);
    expect(manifest.images[0].url_path).toBe(`/api/book/${manifest.images[0].stored_path}`);
    expect(readFileSync(path.join(outDir, manifest.images[0].stored_path!))).toEqual(readFileSync(imagePath));
  });

  it("records missing Markdown images without inventing a rendered URL", () => {
    const dir = tempDir();
    const mdPath = path.join(dir, "paper.md");
    const outDir = path.join(dir, "out");
    writeFileSync(mdPath, "![Missing](missing.png)\n", "utf8");
    const source = readFileSync(mdPath, "utf8");
    const blocks = markdownToBlocks(source);
    const lidNodes = segment(blocks);

    const manifest = buildAssetManifest({
      book_id: "paper-a",
      book_path: mdPath,
      output_dir: outDir,
      source_blocks: blocks,
      lid_nodes: lidNodes,
    });

    expect(AssetManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.images[0]).toMatchObject({
      status: "missing",
      stored_path: null,
      url_path: null,
      warning: "image file was not found relative to the Markdown source",
    });
    expect(existsSync(path.join(outDir, "assets"))).toBe(false);
  });

  it("records remote div-wrapped raw HTML images as external Markdown assets", () => {
    const dir = tempDir();
    const mdPath = path.join(dir, "paper.md");
    const outDir = path.join(dir, "out");
    const remote = "https://example.com/markdown_2/imgs/chart.jpg?authorization=bce-auth-v1%2Ftoken";
    writeFileSync(mdPath, `<div style="text-align: center;"><img src="${remote}" alt="Image" width="42%" /></div>\n`, "utf8");
    const source = readFileSync(mdPath, "utf8");
    const blocks = markdownToBlocks(source);
    const lidNodes = segment(blocks);

    const manifest = buildAssetManifest({
      book_id: "paper-a",
      book_path: mdPath,
      output_dir: outDir,
      source_blocks: blocks,
      lid_nodes: lidNodes,
    });

    expect(AssetManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.images[0]).toMatchObject({
      alt: "Image",
      original_src: remote,
      source: "markdown",
      status: "external",
      stored_path: null,
      url_path: null,
      warning: "external image URL is not copied into the book bundle",
    });
    expect(existsSync(path.join(outDir, "assets"))).toBe(false);
  });

  it("extracts EPUB image files by their XHTML-relative src", () => {
    const dir = tempDir();
    const epubPath = path.join(dir, "book.epub");
    const outDir = path.join(dir, "out");
    const bytes = zipSync({
      "META-INF/container.xml": strToU8(`<container><rootfiles><rootfile full-path="OPS/content.opf"/></rootfiles></container>`),
      "OPS/content.opf": strToU8(`
        <package>
          <manifest><item id="c1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/></manifest>
          <spine><itemref idref="c1"/></spine>
        </package>
      `),
      "OPS/Text/ch1.xhtml": strToU8(`<html><body><img alt="Chart" src="../Images/chart.webp"/></body></html>`),
      "OPS/Images/chart.webp": new Uint8Array([82, 73, 70, 70, 1, 2, 3]),
    });
    writeFileSync(epubPath, bytes);

    const { source, blocks } = epubToSource(new Uint8Array(readFileSync(epubPath)));
    const lidNodes = segment(blocks);
    const manifest = buildAssetManifest({
      book_id: "epub-a",
      book_path: epubPath,
      output_dir: outDir,
      source_blocks: blocks,
      lid_nodes: lidNodes,
    });

    expect(source.trim()).toBe("![Chart](../Images/chart.webp)");
    expect(AssetManifestZ.parse(manifest)).toEqual(manifest);
    expect(manifest.images[0]).toMatchObject({
      alt: "Chart",
      original_src: "../Images/chart.webp",
      source: "epub",
      status: "available",
      mime: "image/webp",
    });
    expect(readFileSync(path.join(outDir, manifest.images[0].stored_path!))).toEqual(Buffer.from([82, 73, 70, 70, 1, 2, 3]));
  });
});
