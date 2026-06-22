// S3 全局目录确定性投影 [ADR-0010 决策4]。merge 后 nodes 纯函数投影成扁平索引,
// 顶替「书无 import 的 neighborMap」,供 Pass2 长程边抽取与图谱检索入口。
// 目录 ≡ 节点(同源投影)⇒ 零幽灵条目;切片0 不带 summary(压缩档,留切片1+)。
import type { GraphNode } from "./generated/GraphNode";
import type { GraphNodeType } from "./generated/GraphNodeType";

export interface CatalogEntry {
  /** 节点 id(entity:{name} | concept:{name} | claim:{lid}:{slug});Pass2 边两端引用它 */
  id: string;
  /** 锚定 LID:实体/概念取 occurrences[0],断言取 source_lid */
  lid: string;
  type: GraphNodeType;
  name: string;
}

/** merge 后存活 nodes → 全局目录(每节点恰一条,零幽灵)。 */
export function projectCatalog(nodes: GraphNode[]): CatalogEntry[] {
  return nodes.map((n) => ({
    id: n.id,
    lid: n.type === "claim" ? (n.source_lid as string) : n.occurrences[0],
    type: n.type,
    name: n.name,
  }));
}
