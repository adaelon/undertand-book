// PB5-3 共享:把书路径载成续建各 CLI 需要的确定性派生(source/lidNodes/byLid/windows)。
// 零落盘、零 LLM —— LID 树 / 窗口都是用时重算的派生([ADR-0012] 不物化派生)。
import { readFileSync } from "node:fs";
import { segment, type SourceBlock } from "../../packages/core/src/segment";
import { markdownToBlocks } from "../../packages/core/src/md-adapter";
import { epubToSource } from "../../packages/core/src/epub-adapter";
import { splitWindows, type Window } from "../../packages/core/src/window";
import type { LidNode } from "../../packages/core/src/generated/LidNode";

export interface LoadedBook {
  source: string;
  lidNodes: LidNode[];
  byLid: Map<string, LidNode>;
  windows: Window[];
}

/** 载书并重算 LID 树 + 窗口(确定性)。epub 走 epubToSource,其余按 md 处理。 */
export function loadBookWindows(book: string): LoadedBook {
  let source: string;
  let blocks: SourceBlock[];
  if (/\.epub$/i.test(book)) ({ source, blocks } = epubToSource(new Uint8Array(readFileSync(book))));
  else { source = readFileSync(book, "utf8"); blocks = markdownToBlocks(source); }
  const lidNodes = segment(blocks);
  const byLid = new Map(lidNodes.map((n) => [n.lid, n]));
  const windows = splitWindows(lidNodes, source);
  return { source, lidNodes, byLid, windows };
}

/** 按 id 取窗口;不存在则报错列出合法 id 范围。 */
export function windowById(windows: Window[], id: number): Window {
  const w = windows.find((x) => x.id === id);
  if (!w) {
    const ids = windows.map((x) => x.id);
    throw new Error(`窗口 id=${id} 不存在(合法 id: ${ids[0]}..${ids[ids.length - 1]},共 ${ids.length} 窗)`);
  }
  return w;
}
