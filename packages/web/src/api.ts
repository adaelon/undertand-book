// 类型化命令面 REST 客户端 `[ADR-0028]`:前端经 `/api` dev proxy 打到 tiny_http。
// 端点名 = 命令名;book.*→GET、reader.*/memory.*/book.query→POST;错误透传 §4.4 信封。
import type { Manifest } from "./generated/Manifest";
import type { QueryResponse } from "./generated/QueryResponse";
import type { ToolError } from "./generated/ToolError";
import type { OuterOutcome } from "./generated/OuterOutcome";
import type { AgentEffect } from "./generated/AgentEffect";
import type { TraceStep } from "./generated/TraceStep";

export type { Manifest, QueryResponse, OuterOutcome, AgentEffect, TraceStep };

const BASE = "/api";

/** reader.* 会话态(符 V3 §4.2),与 Rust `Viewport`/`ReaderState` 对齐(memory 类型未走 ts-rs,在此手定)。 */
export interface Viewport {
  anchor_lid: string;
  visible_lids: string[];
}
export interface ViewportEffect {
  ok: boolean;
  viewport: Viewport;
}
export interface ReaderState {
  viewport: Viewport;
  open_panels: string[];
  selection: string | null;
}
export interface HighlightEffect {
  ok: boolean;
  highlight_id: string;
}
export interface NoteEffect {
  ok: boolean;
  note_id: string;
}
/** 段内字符区间(高亮选区,UTF-16 偏移,相对该 LID 文本)`[ADR-0031]`。 */
export interface TextRange {
  start: number;
  end: number;
}
/** memory 记录(符 V3 §4.3;JSON 字段 `type` = Rust mem_type 的 serde rename)。 */
export interface MemoryRecord {
  mem_id: string;
  type: string;
  layer: string;
  book_id: string;
  anchor: { lid?: string | null; concept?: string | null };
  content: string;
  range?: TextRange | null; // 高亮段内区间;note / 整段高亮为空 `[ADR-0031]`
}
export interface BookText {
  lid: string;
  text: string;
}
export interface FormulaParameter {
  symbol: string;
  label: string | null;
  meaning: string;
  unit: string | null;
  domain: string | null;
  evidence_lids: string[];
}
export interface FormulaComposition {
  source_lid: string;
  meaning: string;
  terms: string[];
  evidence_lids: string[];
}
export interface FormulaContextLink {
  target_lid: string;
  relation: string;
  description: string;
  evidence_lids: string[];
}
export interface FormulaSemantics {
  formula_lid: string;
  parameters: FormulaParameter[];
  composition: FormulaComposition;
  context_links: FormulaContextLink[];
}

/** 携带 §4.4 分类信封的错误(category/error_code 供 UI 分流瞬时 vs 永久)。 */
export class ApiError extends Error {
  constructor(
    public status: number,
    public errorCode: string,
    public category: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function http<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const raw = await res.text();
  const json: unknown = raw ? JSON.parse(raw) : null;
  if (!res.ok) {
    const e = json as ToolError | null;
    throw new ApiError(
      res.status,
      e?.error_code ?? `HTTP_${res.status}`,
      e?.category ?? "internal",
      e?.message ?? raw,
    );
  }
  return json as T;
}

function qs(params: Record<string, string | undefined>): string {
  const pairs = Object.entries(params)
    .filter((kv): kv is [string, string] => kv[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export const api = {
  // ── book.*(只读 GET)──
  manifest: () => http<Manifest>("GET", "/book/manifest"),
  text: (lid: string, end?: string) =>
    http<BookText>("GET", `/book/text${qs({ lid, end })}`),
  formulaSemantics: (lid: string) =>
    http<FormulaSemantics>("GET", `/book/formula_semantics${qs({ lid })}`),
  openBook: (dir: string) => http<{ ok: boolean; book_id: string }>("POST", "/book/open", { dir }),

  // ── book.query(LLM 命令,POST)──
  query: (q: string, anchor_lid?: string) =>
    http<QueryResponse>("POST", "/book/query", { q, anchor_lid }),

  // ── reader.*(可变 POST,返 effect)──
  goto: (lid: string) => http<ViewportEffect>("POST", "/reader/goto", { lid }),
  scroll: (delta: number) => http<ViewportEffect>("POST", "/reader/scroll", { delta }),
  // range?:段内自由高亮 {start,end}(UTF-16 偏移);缺省=整段高亮 `[ADR-0031]`。
  highlight: (lid: string, range?: TextRange) =>
    http<HighlightEffect>("POST", "/reader/highlight", { lid, range }),
  note: (lid: string, text: string) => http<NoteEffect>("POST", "/reader/note", { lid, text }),
  state: () => http<ReaderState>("POST", "/reader/state", {}),

  // ── memory.*(POST)──
  recall: (q: { book_id?: string; lid?: string; type?: string; layer?: string; text?: string } = {}) =>
    http<MemoryRecord[]>("POST", "/memory/recall", q),
  save: (r: { type: string; anchor_lid: string; content: string; layer?: string }) =>
    http<MemoryRecord>("POST", "/memory/save", r),
  delete: (mem_id: string) => http<{ ok: boolean }>("POST", "/memory/delete", { mem_id }),

  // ── agent.*(外层 E agent,POST)`[ADR-0030]` ──
  agentChat: (message: string) => http<OuterOutcome>("POST", "/agent/chat", { message }),
  agentNew: () => http<{ ok: boolean }>("POST", "/agent/new", {}),
};
