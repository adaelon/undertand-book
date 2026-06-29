// PB5-2 跨会话续建续建视图 [ADR-0042]。预构建由 Claude 在环驱动,真书数十窗 Pass1 抽取
// 一个会话跑不完(token/上下文耗尽是常态);新会话零上下文、纯靠磁盘 `.build/pass1/<id>.json`
// 接手。续建判定 = **存在性 + content-hash 校验,位置 id 键,无状态位**:
//   重算窗口 → 逐窗 expected = sha256(buildPass1Input(window).text);
//   磁盘 pass1/<id>.json 在且 content_hash 一致 → done;缺失 / 失配 → pending(二值)。
// 命门:content_hash 必须算自与抽取**同一份**正文(buildPass1Input(window).text),否则陈旧静默复用。
import { createHash } from "node:crypto";
import type { LidNode } from "./generated/LidNode";
import type { Window } from "./window";
import { buildPass1Input, type Pass1Input } from "./pass1-input";

/** Pass1 抽取产物落盘形状(`.build/pass1/<id>.json`);本视图只读 content_hash 判新鲜度。 */
export interface Pass1ArtifactMeta {
  content_hash: string;
}

/** 抽取输入正文的 content hash(sha256 hex)= 跨会话新鲜度锚。算自 buildPass1Input(window).text。 */
export function pass1ContentHash(input: Pass1Input): string {
  return createHash("sha256").update(input.text, "utf8").digest("hex");
}

export interface BuildStatus {
  /** 磁盘已有抽取且 content_hash 与重算一致的窗口 id(升序)。 */
  done: number[];
  /** 缺失或 content_hash 失配、需(重)抽的窗口 id(升序)。 */
  pending: number[];
}

/**
 * 续建状态:逐窗重算 content_hash,对比磁盘已落产物。纯确定性、无文件 IO(磁盘侧由调用方读入)。
 * @param windows  重算出的全部窗口(位置 id 键)。
 * @param byLid    lid → LidNode,供 buildPass1Input 取真原文。
 * @param source   原书正文(切原文用)。
 * @param existing 磁盘 `.build/pass1/<id>.json` 已存在产物:windowId → {content_hash}。
 */
export function computeBuildStatus(
  windows: Window[],
  byLid: Map<string, LidNode>,
  source: string,
  existing: Map<number, Pass1ArtifactMeta>,
): BuildStatus {
  const done: number[] = [];
  const pending: number[] = [];
  for (const w of windows) {
    const expected = pass1ContentHash(buildPass1Input(w, byLid, source));
    const got = existing.get(w.id);
    if (got && got.content_hash === expected) done.push(w.id);
    else pending.push(w.id);
  }
  return { done, pending };
}
