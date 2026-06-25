// SA0 粒度体检 CLI(开发期经 tsx 运行:`pnpm exec tsx skills/build/granularity-profile.ts <epub|md>`)。
// 串:适配器 → GranularityProfile。只统计并给出建议,不进入正式 LID 构建。
import { readFileSync } from "node:fs";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import {
  type AssetCandidateCounts,
  buildGranularityProfile,
  countEpubAssetCandidates,
  countMarkdownAssetCandidates,
} from "../../packages/core/src/granularity";
import type { SourceBlock } from "../../packages/core/src/segment";

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx skills/build/granularity-profile.ts <path-to-epub-or-md>");
  process.exit(2);
}

let blocks: SourceBlock[];
let assetCandidates: AssetCandidateCounts;
if (/\.epub$/i.test(path)) {
  const zip = new Uint8Array(readFileSync(path));
  ({ blocks } = epubToSource(zip));
  assetCandidates = countEpubAssetCandidates(zip);
} else {
  const source = readFileSync(path, "utf8");
  blocks = markdownToBlocks(source);
  assetCandidates = countMarkdownAssetCandidates(source);
}

const profile = buildGranularityProfile(blocks, assetCandidates);

console.log(`[granularity-profile] ${path}`);
console.log(`  paragraph_count=${profile.paragraph_count}`);
console.log(`  sentence_count_estimate=${profile.sentence_count_estimate}`);
console.log(
  `  sentences_per_paragraph avg=${profile.sentence_stats.avg.toFixed(2)} p50=${profile.sentence_stats.p50} p90=${profile.sentence_stats.p90} max=${profile.sentence_stats.max}`,
);
console.log(
  `  long_paragraphs >5=${profile.long_paragraphs.gt5_sentences} >10=${profile.long_paragraphs.gt10_sentences} >800_chars=${profile.long_paragraphs.gt800_chars}`,
);
console.log(
  `  asset_candidates code=${profile.asset_candidates.code} table=${profile.asset_candidates.table} image=${profile.asset_candidates.image} formula=${profile.asset_candidates.formula}`,
);
for (const mode of ["paragraph", "hybrid", "sentence"] as const) {
  const estimate = profile.estimates[mode];
  console.log(
    `  estimate.${mode} projected_lid_count=${estimate.projected_lid_count} expansion_ratio=${estimate.expansion_ratio.toFixed(2)}`,
  );
}
console.log(`  recommendation=${profile.recommendation.mode}`);
console.log(`  reason=${profile.recommendation.reason}`);
console.log("");
console.log(JSON.stringify(profile, null, 2));
