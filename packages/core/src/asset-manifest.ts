import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import type { LidNode } from "./generated/LidNode";
import type { SourceBlock, SourceImageRef } from "./segment";

export type ImageAssetStatus = "available" | "missing" | "external" | "unsupported";
export type ImageAssetSource = "markdown" | "epub" | "data_uri";

export interface ImageAssetManifestEntry {
  kind: "image";
  lid: string;
  alt: string;
  original_src: string;
  source: ImageAssetSource;
  status: ImageAssetStatus;
  stored_path: string | null;
  url_path: string | null;
  mime: string | null;
  sha256: string | null;
  size_bytes: number | null;
  warning: string | null;
}

export interface AssetManifest {
  version: "asset_manifest.v1";
  book_id: string;
  images: ImageAssetManifestEntry[];
}

interface BuildAssetManifestInput {
  book_id: string;
  book_path: string;
  output_dir: string;
  source_blocks: SourceBlock[];
  lid_nodes: LidNode[];
}

const MIME_BY_EXT: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function keyOfSpan(span: { start: number; end: number }): string {
  return `${span.start}:${span.end}`;
}

function lidByImageSpan(lidNodes: LidNode[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of lidNodes) {
    if (node.kind === "image") out.set(keyOfSpan(node.span), node.lid);
  }
  return out;
}

function stripUrlSuffix(src: string): string {
  return src.split("#")[0].split("?")[0];
}

function safeDecodePath(src: string): string {
  try {
    return decodeURIComponent(src);
  } catch {
    return src;
  }
}

function isExternalSrc(src: string): boolean {
  if (path.isAbsolute(src) || path.win32.isAbsolute(src)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(src) && !src.toLowerCase().startsWith("data:");
}

function mimeForPath(src: string): string | null {
  return MIME_BY_EXT[path.extname(stripUrlSuffix(src)).toLowerCase()] ?? null;
}

function extensionFor(src: string, mime: string | null): string {
  const ext = path.extname(stripUrlSuffix(src)).toLowerCase();
  if (ext && MIME_BY_EXT[ext]) return ext;
  if (mime === "image/png") return ".png";
  if (mime === "image/jpeg") return ".jpg";
  if (mime === "image/gif") return ".gif";
  if (mime === "image/webp") return ".webp";
  if (mime === "image/svg+xml") return ".svg";
  if (mime === "image/avif") return ".avif";
  return ".bin";
}

function safeLid(lid: string): string {
  return lid.replace(/[^A-Za-z0-9_-]+/g, "_");
}

function dataUriBytes(src: string): { bytes: Buffer; mime: string } | null {
  const m = /^data:([^;,]+);base64,(.+)$/i.exec(src);
  if (!m || !m[1].toLowerCase().startsWith("image/")) return null;
  return { mime: m[1], bytes: Buffer.from(m[2], "base64") };
}

function markdownImageBytes(bookPath: string, image: SourceImageRef): { bytes: Buffer; mime: string | null } | null {
  const clean = safeDecodePath(stripUrlSuffix(image.src));
  if (!clean) return null;
  const filePath = path.isAbsolute(clean) ? clean : path.resolve(path.dirname(bookPath), clean);
  if (!existsSync(filePath)) return null;
  return { bytes: readFileSync(filePath), mime: mimeForPath(filePath) };
}

function epubImageBytes(files: Record<string, Uint8Array>, image: SourceImageRef): { bytes: Buffer; mime: string | null } | null {
  if (!image.epubPath) return null;
  const data = files[image.epubPath];
  if (!data) return null;
  return { bytes: Buffer.from(data), mime: mimeForPath(image.epubPath) };
}

function availableEntry(
  lid: string,
  image: SourceImageRef,
  source: ImageAssetSource,
  bytes: Buffer,
  mime: string | null,
  outputDir: string,
): ImageAssetManifestEntry {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = `${safeLid(lid)}-${sha256.slice(0, 16)}${extensionFor(image.src, mime)}`;
  const storedPath = `assets/images/${filename}`;
  const target = path.join(outputDir, "assets", "images", filename);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return {
    kind: "image",
    lid,
    alt: image.alt,
    original_src: image.src,
    source,
    status: "available",
    stored_path: storedPath,
    url_path: `/api/book/${storedPath.replace(/\\/g, "/")}`,
    mime: mime ?? "application/octet-stream",
    sha256,
    size_bytes: bytes.length,
    warning: null,
  };
}

function unavailableEntry(
  lid: string,
  image: SourceImageRef,
  source: ImageAssetSource,
  status: Exclude<ImageAssetStatus, "available">,
  warning: string,
): ImageAssetManifestEntry {
  return {
    kind: "image",
    lid,
    alt: image.alt,
    original_src: image.src,
    source,
    status,
    stored_path: null,
    url_path: null,
    mime: null,
    sha256: null,
    size_bytes: null,
    warning,
  };
}

export function buildAssetManifest(input: BuildAssetManifestInput): AssetManifest {
  const lidBySpan = lidByImageSpan(input.lid_nodes);
  const isEpub = /\.epub$/i.test(input.book_path);
  const epubFiles = isEpub ? unzipSync(new Uint8Array(readFileSync(input.book_path))) : null;
  const images: ImageAssetManifestEntry[] = [];

  for (const block of input.source_blocks) {
    if (block.assetKind !== "image" || !block.image || !block.span) continue;
    const lid = lidBySpan.get(keyOfSpan(block.span));
    if (!lid) continue;

    const data = dataUriBytes(block.image.src);
    if (data) {
      images.push(availableEntry(lid, block.image, "data_uri", data.bytes, data.mime, input.output_dir));
      continue;
    }
    if (isExternalSrc(block.image.src)) {
      images.push(
        unavailableEntry(lid, block.image, isEpub ? "epub" : "markdown", "external", "external image URL is not copied into the book bundle"),
      );
      continue;
    }

    const loaded = isEpub && epubFiles
      ? epubImageBytes(epubFiles, block.image)
      : markdownImageBytes(input.book_path, block.image);
    if (!loaded) {
      images.push(
        unavailableEntry(
          lid,
          block.image,
          isEpub ? "epub" : "markdown",
          "missing",
          isEpub ? "image file was not found inside EPUB" : "image file was not found relative to the Markdown source",
        ),
      );
      continue;
    }
    images.push(availableEntry(lid, block.image, isEpub ? "epub" : "markdown", loaded.bytes, loaded.mime, input.output_dir));
  }

  return {
    version: "asset_manifest.v1",
    book_id: input.book_id,
    images,
  };
}
