<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "./api";
import type { AgentEffect, FormulaSemantics, MemoryRecord, OuterOutcome, TraceStep, Viewport } from "./api";
import { renderInlineMarkdown, renderMarkdown } from "./md";
import TopBar from "./components/TopBar.vue";
import LeftRail from "./components/LeftRail.vue";
import ReaderPane from "./components/ReaderPane.vue";
import RightRail from "./components/RightRail.vue";

type NodeKind = import("./api").Manifest["tree"][number]["kind"];
type ManifestNode = import("./api").Manifest["tree"][number];

export interface OutlineItem {
  lid: string;
  kind: NodeKind;
  depth: number;
  title: string;
}
// ── 阅读区会话态 ──
const leafOrder = ref<string[]>([]); // 全书叶 LID 序(读位感分母 + 进度)
const kindByLid = ref<Map<string, NodeKind>>(new Map());
const outlineItems = ref<OutlineItem[]>([]);
const titleByLid = ref<Map<string, string>>(new Map());
const viewport = ref<Viewport | null>(null);
const edgeLoading = ref(false);
const scrollRestoreId = ref(0);
const scrollRestoreDirection = ref<"up" | "down" | null>(null);
interface Segment {
  lid: string;
  text: string;
  kind: NodeKind;
  formula: FormulaSemantics | null;
}
const segments = ref<Segment[]>([]); // 视口内连续正文(LID 隐形)
const annotations = ref<MemoryRecord[]>([]); // 当前书全部标注(客户端按 lid 过滤)
const selectedLid = ref<string | null>(null);
const chapterTitle = ref<string>("");
const sourceFocus = ref<{ lid: string; quote: string | null } | null>(null);

// goto 输入 + 错误条
const gotoInput = ref("");
const outlineSearch = ref("");
const banner = ref<string>("");
const debugOpen = ref(false);
const leftRailOpen = ref(true);
const leftRailWidth = ref(240);
const rightRailWidth = ref(384);
const workspaceStyle = computed(() => ({
  "--left-rail-width": leftRailOpen.value ? `${leftRailWidth.value}px` : "0px",
  "--left-resizer-width": leftRailOpen.value ? "6px" : "0px",
  "--right-rail-width": `${rightRailWidth.value}px`,
}));

function clampLayoutWidth(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
function startResize(which: "left" | "right", event: MouseEvent) {
  if (window.innerWidth < 1024) return;
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = which === "left" ? leftRailWidth.value : rightRailWidth.value;
  const onMove = (move: MouseEvent) => {
    const delta = move.clientX - startX;
    if (which === "left") leftRailWidth.value = clampLayoutWidth(startWidth + delta, 180, 420);
    else rightRailWidth.value = clampLayoutWidth(startWidth - delta, 280, 560);
  };
  const onUp = () => {
    document.body.classList.remove("is-resizing-layout");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  document.body.classList.add("is-resizing-layout");
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp, { once: true });
}

function fail(e: unknown) {
  if (e instanceof ApiError) banner.value = `[${e.category}] ${e.errorCode}: ${e.message}`;
  else banner.value = String(e);
}

// 读位感:anchor 在叶序中的位置 → 进度%;章节 = anchor 顶层段(LID 首段)。
const progressPct = computed(() => {
  const a = viewport.value?.top_lid;
  if (!a || leafOrder.value.length === 0) return 0;
  const idx = leafOrder.value.indexOf(a);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / leafOrder.value.length) * 100);
});
const selectedSegment = computed(() => segments.value.find((seg) => seg.lid === selectedLid.value) ?? null);
const selectedFormula = computed(() => selectedSegment.value?.formula ?? null);
const contextRecords = computed(() => {
  const selected = selectedLid.value;
  const visible = new Set(viewport.value?.visible_lids ?? []);
  return annotations.value
    .filter((r) => {
      const lid = r.anchor.lid;
      return !!lid && (lid === selected || visible.has(lid));
    })
    .sort((a, b) => {
      const aSelected = a.anchor.lid === selected ? 0 : 1;
      const bSelected = b.anchor.lid === selected ? 0 : 1;
      return aSelected - bSelected || (a.anchor.lid ?? "").localeCompare(b.anchor.lid ?? "");
    });
});
const contextNotes = computed(() => contextRecords.value.filter((r) => r.type === "note"));
const contextHighlights = computed(() => contextRecords.value.filter((r) => r.type === "highlight"));

// ── 标注:高亮(整段 / 段内 range)+ 笔记 ──
// 整段高亮(range 缺省)→ <p> 背景;段内 range 高亮 → <mark>(见 renderSeg)`[ADR-0031]`。
function isHighlighted(lid: string): boolean {
  return annotations.value.some((r) => r.anchor.lid === lid && r.type === "highlight" && !r.range);
}
function notesOf(lid: string): MemoryRecord[] {
  return annotations.value.filter((r) => r.anchor.lid === lid && r.type === "note");
}
function highlightsOf(lid: string): MemoryRecord[] {
  return annotations.value.filter((r) => r.anchor.lid === lid && r.type === "highlight");
}

function renderInlineText(s: string): string {
  return renderInlineMarkdown(s);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripMarkdownHeadingLine(line: string): string {
  return line.replace(/^\s{0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/, "$1");
}

function displayText(seg: { text: string; kind?: NodeKind }): { text: string; offset: number } {
  if (seg.kind !== "chapter" && seg.kind !== "section") return { text: seg.text, offset: 0 };
  const match = /^(\s{0,3})(#{1,6})([ \t]+)([\s\S]*)$/.exec(seg.text);
  if (!match) return { text: seg.text, offset: 0 };
  const offset = match[1].length + match[2].length + match[3].length;
  return { text: match[4].replace(/[ \t]+#+\s*$/, "").trimEnd(), offset };
}

function clampRange(n: number, max: number): number {
  return Math.max(0, Math.min(max, n));
}

function leadingQuote(content: string): string | null {
  const quoteLines: string[] = [];
  for (const line of content.split("\\n")) {
    if (line.startsWith(">")) quoteLines.push(line.replace(/^>\\s?/, ""));
    else if (quoteLines.length > 0 && line.trim() === "") break;
    else if (quoteLines.length > 0) break;
  }
  const quote = quoteLines.join(" ").replace(/\\s+/g, " ").trim();
  return quote || null;
}

function sourceFocusRange(text: string, focus: { lid: string; quote: string | null } | null, lid: string): [number, number] | null {
  if (!focus || focus.lid !== lid) return null;
  if (!focus.quote) return [0, text.length];
  const exact = text.indexOf(focus.quote);
  if (exact >= 0) return [exact, exact + focus.quote.length];
  const normalizedQuote = focus.quote.replace(/\s+/g, " ").trim();
  const compact = text.replace(/\s+/g, " ");
  const approx = compact.indexOf(normalizedQuote);
  if (approx < 0) return [0, text.length];
  return [0, text.length];
}

// 段正文渲染:把段内 range 高亮包成 <mark>(合并重叠区间),其余文本转义防 XSS `[ADR-0031]`。
// chapter/section 的 Markdown 标题符号只在显示层剥掉,不改 book.text 原文与 LID 锚点。
function renderSeg(seg: Segment): string {
  const display = displayText(seg);
  const hls = highlightsOf(seg.lid).filter((h) => h.range);
  const focusRange = sourceFocusRange(display.text, sourceFocus.value, seg.lid);
  if (hls.length === 0 && !focusRange) return renderInlineText(display.text);
  const ranges = hls
    .map((h) => {
      const start = clampRange(h.range!.start - display.offset, display.text.length);
      const end = clampRange(h.range!.end - display.offset, display.text.length);
      return [start, end] as [number, number];
    })
    .filter(([start, end]) => end > start);
  if (focusRange) ranges.push(focusRange);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const t = display.text;
  let html = "";
  let cur = 0;
  for (const [s, e] of merged) {
    const cls = focusRange && s === focusRange[0] && e === focusRange[1] ? "hl-mark source-focus-mark" : "hl-mark";
    html += renderInlineText(t.slice(cur, s)) + `<mark class="${cls}">${renderInlineText(t.slice(s, e))}</mark>`;
    cur = e;
  }
  return html + renderInlineText(t.slice(cur));
}
function hlExcerpt(rec: MemoryRecord): string {
  const c = rec.content.replace(/\s+/g, " ").trim();
  if (!rec.range) return "(整段)";
  return c.length > 40 ? c.slice(0, 40) + "…" : c;
}

// 高亮删除 / 修改(=移除后重新框选;高亮无可编辑正文,改 = 改范围 `[ADR-0031]`)。
async function deleteHighlight(rec: MemoryRecord) {
  try {
    banner.value = "";
    await api.delete(rec.mem_id);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
async function modifyHighlight(rec: MemoryRecord) {
  await deleteHighlight(rec);
  if (!banner.value) banner.value = "已移除该高亮——重新框选文字再点「🖍 高亮选区」即可改范围。";
}

// ── 笔记编辑器(内联模态 + 实时 MD/LaTeX 预览)替换 window.prompt ──
const noteEditor = ref<{ lid: string; memId: string | null; layer: string; content: string } | null>(null);
const notePreview = computed(() => renderMarkdown(noteEditor.value?.content ?? ""));
function openNewNote(lid = selectedLid.value, content = "") {
  if (!lid) return;
  noteEditor.value = { lid, memId: null, layer: "long_term", content };
}
function openEditNote(rec: MemoryRecord) {
  noteEditor.value = { lid: rec.anchor.lid ?? "", memId: rec.mem_id, layer: rec.layer, content: rec.content };
}
function cancelNote() {
  noteEditor.value = null;
}
// 保存:新建直接 save;编辑 = 删旧 + 存新(mem_id 内容寻址 `[ADR-0026]`)。
async function saveNote() {
  const ed = noteEditor.value;
  if (!ed) return;
  const content = ed.content.trim();
  if (!content) return;
  try {
    banner.value = "";
    if (ed.memId) await api.delete(ed.memId);
    await api.save({ type: "note", anchor_lid: ed.lid, content, layer: ed.layer });
    noteEditor.value = null;
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
async function deleteNote(rec: MemoryRecord) {
  if (!window.confirm("删除这条笔记?")) return;
  try {
    banner.value = "";
    await api.delete(rec.mem_id);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}

function kindOf(lid: string): NodeKind {
  return kindByLid.value.get(lid) ?? "paragraph";
}
function lidDepth(lid: string): number {
  return lid.split(".").length - 1;
}
function fallbackTitle(lid: string): string {
  return titleByLid.value.get(lid) ?? lid;
}
function firstTitleLine(text: string, lid: string): string {
  const line = text
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean);
  return (line ? stripMarkdownHeadingLine(line) : lid).slice(0, 80);
}
function buildOutline(tree: ManifestNode[]): OutlineItem[] {
  return tree
    .filter((n) => n.children.length > 0 || n.kind === "chapter" || n.kind === "section")
    .map((n) => ({
      lid: n.lid,
      kind: n.kind,
      depth: Math.min(lidDepth(n.lid), 4),
      title: fallbackTitle(n.lid),
    }));
}
async function loadOutlineTitles(tree: ManifestNode[]) {
  const outline = buildOutline(tree);
  outlineItems.value = outline;
  await Promise.all(
    outline.map(async (item) => {
      try {
        const t = await api.text(item.lid);
        titleByLid.value.set(item.lid, firstTitleLine(t.text, item.lid));
      } catch {
        titleByLid.value.set(item.lid, item.lid);
      }
    }),
  );
  outlineItems.value = buildOutline(tree);
}
function isAsset(seg: Segment): boolean {
  return seg.kind === "code" || seg.kind === "table" || seg.kind === "image" || seg.kind === "formula";
}
function imageMeta(text: string): { alt: string; src: string } | null {
  const m = text.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
  return m ? { alt: m[1], src: m[2] } : null;
}
async function formulaFor(lid: string, kind: NodeKind): Promise<FormulaSemantics | null> {
  if (kind !== "formula") return null;
  try {
    return await api.formulaSemantics(lid);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}
async function refreshAnnotations() {
  annotations.value = await api.recall({}); // 单书:取全部,客户端按 lid 过滤
}

// 视口加载:逐 visible_lid 取真原文(连续正文),并刷新标注。
async function loadWindow(vp: Viewport) {
  viewport.value = vp;
  selectedLid.value = vp.top_lid;
  const texts = await Promise.all(vp.visible_lids.map((lid) => api.text(lid)));
  const next = await Promise.all(
    texts.map(async (t) => {
      const kind = kindOf(t.lid);
      return { lid: t.lid, text: t.text, kind, formula: await formulaFor(t.lid, kind) };
    }),
  );
  segments.value = next;
  await refreshAnnotations();
  await loadChapter(vp.top_lid);
}

// 阅读区与服务端 reader 同步(agent 可能改了视口 → 重新拉 state 渲染)。
async function syncViewport() {
  const st = await api.state();
  await loadWindow(st.viewport);
}

// 章节标题:取 anchor 顶层段(LID 首段)原文首行作标签(读位感「第N章…」)。
async function loadChapter(anchorLid: string) {
  const top = anchorLid.split(".")[0];
  try {
    const t = await api.text(top);
    chapterTitle.value = t.text.split("\n")[0].slice(0, 40);
  } catch {
    chapterTitle.value = top;
  }
}

async function init() {
  try {
    const m = await api.manifest();
    kindByLid.value = new Map(m.tree.map((n) => [n.lid, n.kind]));
    leafOrder.value = m.tree.filter((n) => n.children.length === 0).map((n) => n.lid);
    await loadOutlineTitles(m.tree);
    const st = await api.state();
    await loadWindow(st.viewport);
  } catch (e) {
    fail(e);
  }
}
onMounted(init);

// ── 四动作 ──
async function doScroll(delta: number) {
  try {
    banner.value = "";
    sourceFocus.value = null;
    await loadWindow((await api.scroll(delta)).viewport);
  } catch (e) {
    fail(e);
  }
}
async function onScrollEdge(direction: "up" | "down") {
  if (edgeLoading.value || !viewport.value) return;
  const step = Math.max(1, Math.floor(viewport.value.width / 2));
  edgeLoading.value = true;
  try {
    banner.value = "";
    sourceFocus.value = null;
    const before = viewport.value.top_lid;
    const next = (await api.scroll(direction === "down" ? step : -step)).viewport;
    await loadWindow(next);
    if (next.top_lid !== before) {
      scrollRestoreDirection.value = direction;
      scrollRestoreId.value += 1;
    }
  } catch (e) {
    fail(e);
  } finally {
    edgeLoading.value = false;
  }
}
async function doGoto(lid: string, focusQuote?: string | null) {
  if (!lid) return;
  try {
    banner.value = "";
    sourceFocus.value = focusQuote === undefined ? null : { lid, quote: focusQuote };
    await loadWindow((await api.goto(lid)).viewport);
    gotoInput.value = "";
  } catch (e) {
    fail(e);
  }
}
async function focusSource(source: { lid: string; quote: string | null }) {
  await doGoto(source.lid, source.quote);
}
// block actions:整段/asset 高亮和笔记;段内自由高亮走下面的选区 toolbar。
async function highlightBlock(lid: string) {
  try {
    banner.value = "";
    selectedLid.value = lid;
    await api.highlight(lid);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
function noteBlock(lid: string) {
  selectedLid.value = lid;
  openNewNote(lid);
}

// ── 自由选区:可跨多个 LID,高亮按 LID 拆 range;Note/Ask AI 锚到起点 LID `[ADR-0031]` ──
interface SelectedRange {
  lid: string;
  start: number;
  end: number;
}
const hlPopover = ref<{ x: number; y: number; anchorLid: string; ranges: SelectedRange[]; text: string } | null>(null);

function lidElementOf(node: Node | null): HTMLElement | null {
  const el = node && node.nodeType === 3 ? node.parentElement : (node as HTMLElement | null);
  return el ? el.closest("[data-lid]") : null;
}

function selectionRanges(range: Range): SelectedRange[] {
  const startEl = lidElementOf(range.startContainer);
  const endEl = lidElementOf(range.endContainer);
  if (!startEl || !endEl) return [];
  const root = startEl.closest(".prose");
  if (!root || !root.contains(endEl)) return [];

  return Array.from(root.querySelectorAll<HTMLElement>("[data-lid]"))
    .filter((el) => range.intersectsNode(el))
    .map((el) => {
      const lid = el.getAttribute("data-lid") ?? "";
      const textLen = el.textContent?.length ?? 0;
      let start = 0;
      let end = textLen;
      if (el === startEl) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.startContainer, range.startOffset);
        start = pre.toString().length;
      }
      if (el === endEl) {
        const pre = document.createRange();
        pre.selectNodeContents(el);
        pre.setEnd(range.endContainer, range.endOffset);
        end = pre.toString().length;
      }
      return { lid, start, end };
    })
    .filter((r) => r.lid && r.end > r.start);
}

function onProseMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hlPopover.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const ranges = selectionRanges(range);
  if (ranges.length === 0) {
    hlPopover.value = null;
    return;
  }
  const quote = range.toString();
  if (!quote.trim()) {
    hlPopover.value = null;
    return;
  }
  const rect = range.getBoundingClientRect();
  hlPopover.value = {
    x: rect.left + rect.width / 2,
    y: rect.top,
    anchorLid: ranges[0].lid,
    ranges,
    text: quote,
  };
}
async function confirmHighlight() {
  const p = hlPopover.value;
  if (!p) return;
  try {
    banner.value = "";
    await Promise.all(p.ranges.map((r) => api.highlight(r.lid, { start: r.start, end: r.end })));
    selectedLid.value = p.anchorLid;
    hlPopover.value = null;
    window.getSelection()?.removeAllRanges();
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
function noteSelection() {
  const p = hlPopover.value;
  if (!p) return;
  const quote = p.text.replace(/\s+/g, " ").trim();
  selectedLid.value = p.anchorLid;
  hlPopover.value = null;
  window.getSelection()?.removeAllRanges();
  openNewNote(p.anchorLid, quote ? `> ${quote}` : "");
}
function askSelection() {
  const p = hlPopover.value;
  if (!p) return;
  const quote = p.text.replace(/\s+/g, " ").trim();
  if (!quote) return;
  askDraft.value = { lid: p.anchorLid, quote };
  selectedLid.value = p.anchorLid;
  agentInput.value = "";
  hlPopover.value = null;
  window.getSelection()?.removeAllRanges();
}
function clearAskDraft() {
  askDraft.value = null;
}

// ── agent 对话区(外层 E agent 主入口)`[ADR-0030]` ──
interface ChatTurn {
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  questionAnchorLid: string | null;
  questionQuote: AskDraft | null;
}
interface AskDraft {
  lid: string;
  quote: string;
}
const chat = ref<ChatTurn[]>([]);
const agentInput = ref("");
const askDraft = ref<AskDraft | null>(null);
const sending = ref(false);
const showTrace = ref<Record<string, boolean>>({});
const latestTrace = computed<TraceStep[]>(() => {
  for (let i = chat.value.length - 1; i >= 0; i -= 1) {
    const trace = chat.value[i].outcome?.trace;
    if (trace?.length) return trace;
  }
  return [];
});
// 提议处置态:key=`${turnIdx}:${effIdx}` → "已保留" | "已撤销"。
const handled = ref<Record<string, string>>({});
function effKey(ti: number, ei: number) {
  return `${ti}:${ei}`;
}
function effState(ti: number, ei: number): string | undefined {
  return handled.value[effKey(ti, ei)];
}
function toggleTrace(ti: number) {
  showTrace.value[ti] = !showTrace.value[ti];
}

// AgentEffect 判别(在 TS 里 narrow,避开模板里的联合类型收窄)。
function isGoto(e: AgentEffect): boolean {
  return e.kind === "Goto";
}
function effLabel(e: AgentEffect): string {
  if (e.kind === "Goto") return `📖 翻到 ${e.after_anchor}`;
  if (e.kind === "Highlight") return `🖍 高亮 ${e.lid}`;
  return `📝 笔记 ${e.lid}`;
}
function gotoBack(e: AgentEffect): string {
  return e.kind === "Goto" ? e.before_anchor : "";
}

async function sendAgent() {
  const msg = agentInput.value.trim();
  if (!msg) return;
  const draft = askDraft.value;
  const questionAnchorLid = draft?.lid ?? viewport.value?.top_lid ?? null;
  const outbound = draft
    ? `引用原文 [LID: ${draft.lid}]:\n「${draft.quote}」\n\n我的问题:\n${msg}`
    : msg;
  const turn: ChatTurn = { user: msg, outcome: null, pending: true, questionAnchorLid, questionQuote: draft ? { ...draft } : null };
  chat.value.push(turn);
  agentInput.value = "";
  sending.value = true;
  banner.value = "";
  try {
    turn.outcome = await api.agentChat(outbound);
    // agent 可能驱动了共享 reader 视口 / 落了 session 标注 → 同步阅读区。
    askDraft.value = null;
    await syncViewport();
  } catch (e) {
    turn.error = e instanceof ApiError ? `[${e.category}] ${e.errorCode}: ${e.message}` : String(e);
  } finally {
    turn.pending = false;
    sending.value = false;
  }
}

// 提议「撤销」:Goto→ 返回回合前 anchor;Highlight/Note→ memory.delete(mem_id)。
async function undoEffect(ti: number, ei: number, e: AgentEffect) {
  try {
    banner.value = "";
    if (e.kind === "Goto") {
      await api.goto(e.before_anchor);
      await syncViewport();
    } else {
      await api.delete(e.mem_id);
      await refreshAnnotations();
    }
    handled.value[effKey(ti, ei)] = "已撤销";
  } catch (err) {
    fail(err);
  }
}

// 提议「保留」(Highlight/Note):同内容以 long_term 再 save → 同 mem_id upsert 升级层。
async function keepEffect(ti: number, ei: number, e: AgentEffect) {
  if (e.kind === "Goto") return;
  try {
    banner.value = "";
    let content = e.kind === "Note" ? e.text : "";
    if (e.kind === "Highlight") {
      const recs = await api.recall({ layer: "session" });
      content = recs.find((r) => r.mem_id === e.mem_id)?.content ?? "";
    }
    await api.save({
      type: e.kind === "Highlight" ? "highlight" : "note",
      anchor_lid: e.lid,
      content,
      layer: "long_term",
    });
    await refreshAnnotations();
    handled.value[effKey(ti, ei)] = "已保留";
  } catch (err) {
    fail(err);
  }
}

async function saveAgentSelection(turn: ChatTurn, text: string) {
  const anchor = turn.questionAnchorLid;
  const content = text.trim();
  if (!content || !anchor) return;
  const sourceQuote = turn.questionQuote?.quote.replace(/\s+/g, " ").trim();
  const noteContent = sourceQuote ? `> ${sourceQuote}\n\n${content}` : content;
  try {
    banner.value = "";
    await api.save({ type: "note", anchor_lid: anchor, content: noteContent, layer: "long_term" });
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}

async function newChat() {
  try {
    await api.agentNew();
    chat.value = [];
    handled.value = {};
  } catch (e) {
    fail(e);
  }
}
async function openBook() {
  const dir = window.prompt("Book directory", ".understand-book/quantification-essence");
  if (!dir?.trim()) return;
  try {
    banner.value = "";
    await api.openBook(dir.trim());
    leafOrder.value = [];
    kindByLid.value = new Map();
    outlineItems.value = [];
    titleByLid.value = new Map();
    viewport.value = null;
    segments.value = [];
    annotations.value = [];
    selectedLid.value = null;
    chapterTitle.value = "";
    gotoInput.value = "";
    outlineSearch.value = "";
    chat.value = [];
    handled.value = {};
    showTrace.value = {};
    await init();
  } catch (e) {
    fail(e);
  }
}
</script>

<template>
  <div class="app">
    <TopBar
      :chapter-title="chapterTitle"
      :progress-pct="progressPct"
      :anchor-lid="viewport?.top_lid ?? null"
      :debug-open="debugOpen"
      :left-rail-open="leftRailOpen"
      @scroll="doScroll"
      @new-chat="newChat"
      @open-book="openBook"
      @toggle-left-rail="leftRailOpen = !leftRailOpen"
      @toggle-debug="debugOpen = !debugOpen"
    />

    <p v-if="banner" class="banner">{{ banner }}</p>

    <div class="workspace-grid" :class="{ 'left-collapsed': !leftRailOpen }" :style="workspaceStyle">
      <LeftRail
        v-show="leftRailOpen"
        v-model:goto-input="gotoInput"
        v-model:search-query="outlineSearch"
        :outline-items="outlineItems"
        :progress-pct="progressPct"
        :anchor-lid="viewport?.top_lid ?? null"
        :selected-lid="selectedLid"
        :leaf-count="leafOrder.length"
        :debug-open="debugOpen"
        @goto="doGoto"
      />

      <div
        class="resize-handle resize-handle-left"
        role="separator"
        aria-orientation="vertical"
        title="Resize outline"
        @mousedown="startResize('left', $event)"
      ></div>

      <ReaderPane
        :segments="segments"
        :viewport-anchor="viewport?.anchor_lid ?? null"
        :selected-lid="selectedLid"
        :render-seg="renderSeg"
        :render-markdown="renderMarkdown"
        :is-asset="isAsset"
        :is-highlighted="isHighlighted"
        :highlights-of="highlightsOf"
        :notes-of="notesOf"
        :hl-excerpt="hlExcerpt"
        :image-meta="imageMeta"
        :scroll-restore-id="scrollRestoreId"
        :scroll-restore-direction="scrollRestoreDirection"
        @select="selectedLid = $event"
        @prose-mouse-up="onProseMouseUp"
        @scroll-edge="onScrollEdge"
        @highlight-block="highlightBlock"
        @note-block="noteBlock"
        @goto="doGoto"
        @focus-source="focusSource"
        @modify-highlight="modifyHighlight"
        @delete-highlight="deleteHighlight"
        @edit-note="openEditNote"
        @delete-note="deleteNote"
      />

      <div
        class="resize-handle resize-handle-right"
        role="separator"
        aria-orientation="vertical"
        title="Resize context rail"
        @mousedown="startResize('right', $event)"
      ></div>

      <RightRail
        v-model:agent-input="agentInput"
        :chat="chat"
        :sending="sending"
        :show-trace="showTrace"
        :latest-trace="latestTrace"
        :selected-lid="selectedLid"
        :selected-formula="selectedFormula"
        :context-notes="contextNotes"
        :context-highlights="contextHighlights"
        :render-markdown="renderMarkdown"
        :eff-label="effLabel"
        :eff-state="effState"
        :is-goto="isGoto"
        :goto-back="gotoBack"
        :ask-draft="askDraft"
        @send-agent="sendAgent"
        @new-chat="newChat"
        @clear-ask="clearAskDraft"
        @goto="doGoto"
        @focus-source="focusSource"
        @toggle-trace="toggleTrace"
        @undo-effect="undoEffect"
        @keep-effect="keepEffect"
        @save-answer-selection="saveAgentSelection"
      />
    </div>

    <div
      v-if="hlPopover"
      class="hl-popover"
      :style="{ left: hlPopover.x + 'px', top: hlPopover.y - 40 + 'px' }"
    >
      <button @mousedown.prevent="confirmHighlight">Highlight</button>
      <button @mousedown.prevent="noteSelection">Note</button>
      <button @mousedown.prevent="askSelection">Ask AI</button>
    </div>

    <div v-if="noteEditor" class="note-modal" @click.self="cancelNote">
      <div class="note-dialog">
        <div class="nd-head">
          <span>{{ noteEditor.memId ? "Edit note" : "New note" }} · {{ noteEditor.lid }}</span>
          <button class="nd-close" title="关闭" @click="cancelNote">×</button>
        </div>
        <div class="nd-body">
          <textarea
            v-model="noteEditor.content"
            class="nd-input"
            placeholder="Markdown and LaTeX supported: **bold**, - lists, $E=mc^2$ …"
            @keydown.ctrl.enter="saveNote"
          ></textarea>
          <div class="nd-preview md" v-html="notePreview"></div>
        </div>
        <div class="nd-foot">
          <span class="nd-hint">Ctrl+Enter saves · Markdown/LaTeX preview</span>
          <span class="nd-actions">
            <button @click="cancelNote">Cancel</button>
            <button class="primary" :disabled="!noteEditor.content.trim()" @click="saveNote">Save</button>
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
<style scoped>
.agent {
  /* 固定宽侧栏:flex 0 0 不随内容增长。修 S10g 回归——面板 class 从 .qa 改 .agent 时丢了 width,
     默认 flex:0 1 auto 让右栏被长答案/trace 内容撑满全屏、挤垮分屏与按钮。 */
  flex: 0 0 24rem;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--line);
  min-width: 0;
  padding: 1rem;
  overflow-y: auto;
}
.agent-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.new-chat {
  font-size: 0.85em;
}
.transcript {
  flex: 1;
  overflow-y: auto;
  /* 长答案/无空格长串(trace digest、JSON args)在固定宽侧栏内换行,不横向撑破。 */
  overflow-wrap: anywhere;
  word-break: break-word;
}
.turn {
  margin-bottom: 1.2em;
}
.u-msg {
  font-weight: 600;
}
.a-msg {
  background: #f7f7f9;
  border-radius: 6px;
  padding: 0.6em 0.8em;
}
/* `.md` 渲染排版移到全局 style.css —— scoped 样式够不到 v-html 注入的子节点。 */
.pending {
  color: #888;
}
.incomplete {
  color: #b35;
}
.proposals {
  margin-top: 0.6em;
  border-top: 1px dashed #ccc;
  padding-top: 0.4em;
}
.prop-h {
  font-size: 0.8em;
  color: #666;
}
.proposal {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0.25em 0;
  font-size: 0.9em;
}
.prop-label {
  flex: 1;
}
.proposal button.undo {
  color: #b35;
}
.done {
  color: #393;
  font-size: 0.85em;
}
.trace {
  margin-top: 0.5em;
}
.trace-toggle {
  font-size: 0.8em;
  background: none;
  border: none;
  color: #57a;
  cursor: pointer;
  padding: 0;
}
.trace ol {
  font-size: 0.8em;
  color: #555;
  margin: 0.3em 0 0;
  padding-left: 1.4em;
}
.trace .t-args {
  color: #777;
}
.trace .t-res {
  color: #999;
}
.agent-input {
  display: flex;
  flex-direction: column;
  gap: 0.4em;
  border-top: 1px solid #ddd;
  padding-top: 0.5em;
}
.agent-input textarea {
  width: 100%;
  box-sizing: border-box;
}

/* 段内选区浮动工具条 */
.hl-popover {
  position: fixed;
  transform: translateX(-50%);
  z-index: 50;
  display: flex;
  gap: 0.25rem;
  padding: 0.25rem;
  border-radius: 999px;
  background: #1a1a1a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
}
.hl-popover button {
  background: transparent;
  color: #fff;
  border: none;
  border-radius: 999px;
  padding: 0.28rem 0.65rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.hl-popover button:hover {
  background: rgba(255, 255, 255, 0.12);
}

/* 笔记编辑器模态 */
.note-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 60;
}
.note-dialog {
  width: min(46rem, 92vw);
  max-height: 86vh;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.nd-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--line);
  font-weight: 600;
}
.nd-close {
  border: none;
  background: none;
  font-size: 1rem;
  cursor: pointer;
  color: var(--muted);
}
.nd-body {
  display: flex;
  gap: 0;
  flex: 1;
  min-height: 16rem;
}
.nd-input {
  flex: 1;
  border: none;
  border-right: 1px solid var(--line);
  padding: 1rem;
  font: inherit;
  resize: none;
  outline: none;
}
.nd-preview {
  flex: 1;
  padding: 1rem;
  overflow-y: auto;
  background: #fcfcfd;
}
.nd-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 1rem;
  border-top: 1px solid var(--line);
}
.nd-hint {
  color: var(--muted);
  font-size: 0.8rem;
}
.nd-actions {
  display: flex;
  gap: 0.5rem;
}
.nd-actions .primary {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
</style>
