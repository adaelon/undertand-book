import { unzipSync, strFromU8 } from "fflate";
import { parse, HTMLElement } from "node-html-parser";
import type { SourceBlock } from "./segment";

export interface AssetCandidateCounts {
  code: number;
  table: number;
  image: number;
  formula: number;
}

export interface SentenceStats {
  avg: number;
  p50: number;
  p90: number;
  max: number;
}

export type GranularityChoice = "paragraph" | "hybrid" | "sentence";

export interface GranularityEstimate {
  mode: GranularityChoice;
  projected_lid_count: number;
  expansion_ratio: number;
}

export interface GranularityProfile {
  paragraph_count: number;
  sentence_count_estimate: number;
  sentence_stats: SentenceStats;
  long_paragraphs: {
    gt5_sentences: number;
    gt10_sentences: number;
    gt800_chars: number;
  };
  asset_candidates: AssetCandidateCounts;
  estimates: Record<GranularityChoice, GranularityEstimate>;
  recommendation: {
    mode: GranularityChoice;
    reason: string;
  };
}

export const emptyAssetCandidateCounts = (): AssetCandidateCounts => ({
  code: 0,
  table: 0,
  image: 0,
  formula: 0,
});

const totalAssets = (counts: AssetCandidateCounts): number =>
  counts.code + counts.table + counts.image + counts.formula;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

export function estimateSentenceCount(text: string): number {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return 0;
  let count = 0;
  let sawTextSinceBoundary = false;
  for (let i = 0; i < normalized.length; i += 1) {
    const ch = normalized[i];
    if (/\s/.test(ch)) continue;
    sawTextSinceBoundary = true;
    const prev = normalized[i - 1] ?? "";
    const next = normalized[i + 1] ?? "";
    const cjkOrBangQuestion = /[。！？!?]/.test(ch);
    const englishPeriod =
      ch === "." && !/\d/.test(prev) && !/\d/.test(next) && (!next || /[\s"'”’）】》\])]/.test(next));
    if (sawTextSinceBoundary && (cjkOrBangQuestion || englishPeriod)) {
      count += 1;
      sawTextSinceBoundary = false;
    }
  }
  return Math.max(1, count + (sawTextSinceBoundary ? 1 : 0));
}

function lineLooksLikeTable(line: string): boolean {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|")) return false;
  return (t.match(/\|/g) ?? []).length >= 3;
}

function leafLooksLikeAssetCandidate(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^!\[[^\]]*]\([^)]+\)$/.test(t)) return true;
  if (/^(```|~~~)[\s\S]*(\n|\r\n)(```|~~~)$/.test(t)) return true;
  if (/^\$\$[\s\S]*\$\$$/.test(t)) return true;
  const lines = t.split(/\r?\n/).filter(Boolean);
  return lines.length > 0 && lines.every(lineLooksLikeTable);
}

export function countMarkdownAssetCandidates(src: string): AssetCandidateCounts {
  const counts = emptyAssetCandidateCounts();
  const lines = src.split(/\r?\n/);
  let inFence = false;
  let currentTable = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!inFence) counts.code += 1;
      inFence = !inFence;
      currentTable = false;
      continue;
    }
    if (inFence) continue;

    if (lineLooksLikeTable(line)) {
      if (!currentTable) counts.table += 1;
      currentTable = true;
    } else {
      currentTable = false;
    }

    counts.image += (line.match(/!\[[^\]]*]\([^)]+\)/g) ?? []).length;
  }

  counts.formula += (src.match(/\$\$[\s\S]*?\$\$/g) ?? []).length;
  const withoutBlocks = src.replace(/\$\$[\s\S]*?\$\$/g, "");
  counts.formula += (withoutBlocks.match(/(^|[^\\$])\$[^$\n]+\$/g) ?? []).length;
  return counts;
}

function walkAssetTags(el: HTMLElement, counts: AssetCandidateCounts): void {
  for (const child of el.childNodes) {
    if (child.nodeType !== 1) continue;
    const e = child as HTMLElement;
    const tag = (e.rawTagName ?? "").toLowerCase();
    if (tag === "pre") counts.code += 1;
    else if (tag === "table") counts.table += 1;
    else if (tag === "img") counts.image += 1;
    else if (tag === "math" || tag === "m:math") counts.formula += 1;
    walkAssetTags(e, counts);
  }
}

export function countXhtmlAssetCandidates(html: string): AssetCandidateCounts {
  const counts = emptyAssetCandidateCounts();
  const root = parse(html);
  const body = root.querySelector("body") ?? root;
  walkAssetTags(body, counts);
  return counts;
}

export function countEpubAssetCandidates(zip: Uint8Array): AssetCandidateCounts {
  const counts = emptyAssetCandidateCounts();
  const files = unzipSync(zip);
  const container = files["META-INF/container.xml"];
  if (!container) return counts;
  const opfPath = /full-path="([^"]+)"/.exec(strFromU8(container))?.[1];
  if (!opfPath || !files[opfPath]) return counts;
  const opf = strFromU8(files[opfPath]);
  const opfDir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\s[^>]*>/g)) {
    const tag = m[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }
  for (const m of opf.matchAll(/<itemref\s[^>]*\bidref="([^"]+)"/g)) {
    const href = manifest.get(m[1]);
    if (!href) continue;
    const path = opfDir + decodeURIComponent(href);
    const data = files[path];
    if (!data) continue;
    const c = countXhtmlAssetCandidates(strFromU8(data));
    counts.code += c.code;
    counts.table += c.table;
    counts.image += c.image;
    counts.formula += c.formula;
  }
  return counts;
}

export function buildGranularityProfile(
  blocks: SourceBlock[],
  assetCandidates: AssetCandidateCounts = emptyAssetCandidateCounts(),
): GranularityProfile {
  const paragraphs = blocks.filter((b) => b.kind === "leaf" && !leafLooksLikeAssetCandidate(b.text));
  const perParagraphSentences = paragraphs.map((b) => estimateSentenceCount(b.text));
  const sentence_count_estimate = perParagraphSentences.reduce((sum, n) => sum + n, 0);
  const sorted = [...perParagraphSentences].sort((a, b) => a - b);
  const paragraph_count = paragraphs.length;
  const paragraphBase = Math.max(1, paragraph_count);
  const longParagraphs = {
    gt5_sentences: perParagraphSentences.filter((n) => n > 5).length,
    gt10_sentences: perParagraphSentences.filter((n) => n > 10).length,
    gt800_chars: paragraphs.filter((b) => b.text.length > 800).length,
  };
  const hybridSentenceChildren = paragraphs.reduce((sum, block, index) => {
    const sentenceCount = perParagraphSentences[index] ?? 0;
    return sentenceCount > 5 || block.text.length > 800 ? sum + sentenceCount : sum;
  }, 0);
  const assetCount = totalAssets(assetCandidates);
  const baseLids = paragraph_count + assetCount;
  const paragraphLids = baseLids;
  const hybridLids = baseLids + hybridSentenceChildren;
  const sentenceLids = baseLids + sentence_count_estimate;

  const estimates: Record<GranularityChoice, GranularityEstimate> = {
    paragraph: {
      mode: "paragraph",
      projected_lid_count: paragraphLids,
      expansion_ratio: paragraphLids / paragraphBase,
    },
    hybrid: {
      mode: "hybrid",
      projected_lid_count: hybridLids,
      expansion_ratio: hybridLids / paragraphBase,
    },
    sentence: {
      mode: "sentence",
      projected_lid_count: sentenceLids,
      expansion_ratio: sentenceLids / paragraphBase,
    },
  };

  const p90 = percentile(sorted, 90);
  const longShare =
    paragraph_count === 0
      ? 0
      : Math.max(longParagraphs.gt5_sentences, longParagraphs.gt800_chars) / paragraph_count;
  const recommendation: GranularityProfile["recommendation"] =
    p90 <= 3 && longParagraphs.gt5_sentences === 0 && longParagraphs.gt800_chars === 0
      ? {
          mode: "paragraph",
          reason: "p90 每段句数不高且没有长段,段级坐标成本最低。",
        }
      : p90 > 5 || longShare >= 0.1
        ? {
            mode: "hybrid",
            reason: "长段占比或 p90 每段句数偏高,hybrid 只展开长段以控制 LID 膨胀。",
          }
        : {
            mode: "paragraph",
            reason: "长段信号不明显,默认不展开全书句级。",
          };

  return {
    paragraph_count,
    sentence_count_estimate,
    sentence_stats: {
      avg:
        paragraph_count === 0
          ? 0
          : sentence_count_estimate / paragraph_count,
      p50: percentile(sorted, 50),
      p90,
      max: sorted[sorted.length - 1] ?? 0,
    },
    long_paragraphs: longParagraphs,
    asset_candidates: { ...assetCandidates },
    estimates,
    recommendation,
  };
}
