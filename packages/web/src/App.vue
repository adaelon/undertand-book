<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "./api";
import type { AgentEffect, FormulaSemantics, MemoryRecord, OuterOutcome, Viewport } from "./api";
import { renderMarkdown } from "./md";

type NodeKind = import("./api").Manifest["tree"][number]["kind"];

// ── 阅读区会话态 ──
const leafOrder = ref<string[]>([]); // 全书叶 LID 序(读位感分母 + 进度)
const kindByLid = ref<Map<string, NodeKind>>(new Map());
const viewport = ref<Viewport | null>(null);
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

// goto 输入 + 错误条
const gotoInput = ref("");
const banner = ref<string>("");

function fail(e: unknown) {
  if (e instanceof ApiError) banner.value = `[${e.category}] ${e.errorCode}: ${e.message}`;
  else banner.value = String(e);
}

// 读位感:anchor 在叶序中的位置 → 进度%;章节 = anchor 顶层段(LID 首段)。
const progressPct = computed(() => {
  const a = viewport.value?.anchor_lid;
  if (!a || leafOrder.value.length === 0) return 0;
  const idx = leafOrder.value.indexOf(a);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / leafOrder.value.length) * 100);
});

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// 段正文渲染:把段内 range 高亮包成 <mark>(合并重叠区间),其余文本转义防 XSS `[ADR-0031]`。
function renderSeg(seg: { lid: string; text: string }): string {
  const hls = highlightsOf(seg.lid).filter((h) => h.range);
  if (hls.length === 0) return escapeHtml(seg.text);
  const ranges = hls
    .map((h) => [h.range!.start, h.range!.end] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [s, e] of ranges) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  const t = seg.text;
  let html = "";
  let cur = 0;
  for (const [s, e] of merged) {
    html += escapeHtml(t.slice(cur, s)) + `<mark class="hl-mark">${escapeHtml(t.slice(s, e))}</mark>`;
    cur = e;
  }
  return html + escapeHtml(t.slice(cur));
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
function openNewNote() {
  if (!selectedLid.value) return;
  noteEditor.value = { lid: selectedLid.value, memId: null, layer: "long_term", content: "" };
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
  selectedLid.value = vp.anchor_lid;
  const texts = await Promise.all(vp.visible_lids.map((lid) => api.text(lid)));
  const next = await Promise.all(
    texts.map(async (t) => {
      const kind = kindOf(t.lid);
      return { lid: t.lid, text: t.text, kind, formula: await formulaFor(t.lid, kind) };
    }),
  );
  segments.value = next;
  await refreshAnnotations();
  await loadChapter(vp.anchor_lid);
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
    await loadWindow((await api.scroll(delta)).viewport);
  } catch (e) {
    fail(e);
  }
}
async function doGoto(lid: string) {
  if (!lid) return;
  try {
    banner.value = "";
    await loadWindow((await api.goto(lid)).viewport);
    gotoInput.value = "";
  } catch (e) {
    fail(e);
  }
}
// 工具栏 🖍:整段高亮当前选中段(range 缺省);段内自由高亮走下面的选区 popover。
async function doHighlight() {
  if (!selectedLid.value) return;
  try {
    banner.value = "";
    await api.highlight(selectedLid.value);
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}
function doNote() {
  openNewNote();
}

// ── 段内自由高亮:选区捕获 → 浮动按钮 → 精确 UTF-16 区间高亮 `[ADR-0031]` ──
const hlPopover = ref<{ x: number; y: number; lid: string; start: number; end: number } | null>(null);
function onProseMouseUp() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
    hlPopover.value = null;
    return;
  }
  const range = sel.getRangeAt(0);
  const pOf = (n: Node | null): HTMLElement | null => {
    const el = n && n.nodeType === 3 ? n.parentElement : (n as HTMLElement | null);
    return el ? el.closest("[data-lid]") : null;
  };
  const startP = pOf(range.startContainer);
  // 仅支持单个 LID 内选区(跨 LID 留后);两端须同一 data-lid 容器。
  if (!startP || startP !== pOf(range.endContainer)) {
    hlPopover.value = null;
    return;
  }
  const lid = startP.getAttribute("data-lid");
  if (!lid) {
    hlPopover.value = null;
    return;
  }
  // 段内 UTF-16 偏移 = 选区起点前的文本长度(toString().length 即 UTF-16 code unit 数)。
  const pre = document.createRange();
  pre.selectNodeContents(startP);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  if (end <= start) {
    hlPopover.value = null;
    return;
  }
  const rect = range.getBoundingClientRect();
  hlPopover.value = { x: rect.left + rect.width / 2, y: rect.top, lid, start, end };
}
async function confirmHighlight() {
  const p = hlPopover.value;
  if (!p) return;
  try {
    banner.value = "";
    await api.highlight(p.lid, { start: p.start, end: p.end });
    hlPopover.value = null;
    window.getSelection()?.removeAllRanges();
    await refreshAnnotations();
  } catch (e) {
    fail(e);
  }
}

// ── agent 对话区(外层 E agent 主入口)`[ADR-0030]` ──
interface ChatTurn {
  user: string;
  outcome: OuterOutcome | null;
  pending: boolean;
  error?: string;
  distilled?: boolean;
}
const chat = ref<ChatTurn[]>([]);
const agentInput = ref("");
const sending = ref(false);
const showTrace = ref<Record<string, boolean>>({});
// 提议处置态:key=`${turnIdx}:${effIdx}` → "已保留" | "已撤销"。
const handled = ref<Record<string, string>>({});
function effKey(ti: number, ei: number) {
  return `${ti}:${ei}`;
}
function effState(ti: number, ei: number): string | undefined {
  return handled.value[effKey(ti, ei)];
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
  const turn: ChatTurn = { user: msg, outcome: null, pending: true };
  chat.value.push(turn);
  agentInput.value = "";
  sending.value = true;
  banner.value = "";
  try {
    turn.outcome = await api.agentChat(msg);
    // agent 可能驱动了共享 reader 视口 / 落了 session 标注 → 同步阅读区。
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

// 对话末「凝练成笔记」:把 answer 存为 note(锚当前视口 anchor),long_term。
async function distill(turn: ChatTurn) {
  const ans = turn.outcome?.answer;
  const anchor = viewport.value?.anchor_lid;
  if (!ans || !anchor) return;
  try {
    banner.value = "";
    await api.save({ type: "note", anchor_lid: anchor, content: ans, layer: "long_term" });
    turn.distilled = true;
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
</script>

<template>
  <div class="app">
    <header class="topbar">
      <span class="title">📖 {{ chapterTitle || "understand-book" }}</span>
      <span class="progress">{{ progressPct }}%</span>
      <span class="pos" v-if="viewport">@ {{ viewport.anchor_lid }}</span>
    </header>

    <p v-if="banner" class="banner">{{ banner }}</p>

    <div class="body">
      <!-- 阅读区:连续正文(LID 隐形,段落承 data-lid 作隐形锚) -->
      <main class="reader">
        <div class="controls">
          <button @click="doScroll(-3)">▲ 上翻</button>
          <button @click="doScroll(3)">▼ 下翻</button>
          <input
            v-model="gotoInput"
            placeholder="跳转 LID(如 11.18.4)"
            @keyup.enter="doGoto(gotoInput)"
          />
          <button @click="doGoto(gotoInput)">跳转</button>
          <span class="sel">选中: {{ selectedLid ?? "—" }}</span>
          <button :disabled="!selectedLid" @click="doHighlight">🖍 高亮</button>
          <button :disabled="!selectedLid" @click="doNote">📝 笔记</button>
        </div>

        <article class="prose" @mouseup="onProseMouseUp">
          <div v-for="seg in segments" :key="seg.lid" class="seg">
            <!-- 普通段落连续渲染;asset 叶子按 ManifestNode.kind 分派,仍保留 data-lid 隐形锚。 -->
            <p
              v-if="!isAsset(seg)"
              :data-lid="seg.lid"
              :class="{
                anchor: seg.lid === viewport?.anchor_lid,
                selected: seg.lid === selectedLid,
                hl: isHighlighted(seg.lid),
              }"
              @click="selectedLid = seg.lid"
              v-html="renderSeg(seg)"
            ></p>
            <section
              v-else
              :data-lid="seg.lid"
              class="asset-block"
              :class="[`asset-${seg.kind}`, {
                anchor: seg.lid === viewport?.anchor_lid,
                selected: seg.lid === selectedLid,
                hl: isHighlighted(seg.lid),
              }]"
              @click="selectedLid = seg.lid"
            >
              <div class="asset-head">
                <span>{{ seg.kind }}</span>
                <button class="asset-jump" title="选中该 LID" @click.stop="selectedLid = seg.lid">定位</button>
              </div>
              <pre v-if="seg.kind === 'code'" class="asset-source asset-code"><code v-html="renderSeg(seg)"></code></pre>
              <pre v-else-if="seg.kind === 'table'" class="asset-source asset-table" v-html="renderSeg(seg)"></pre>
              <figure v-else-if="seg.kind === 'image'" class="asset-image-figure">
                <div class="image-preview">
                  <span>image</span>
                  <strong>{{ imageMeta(seg.text)?.alt || '未命名图片' }}</strong>
                  <code>{{ imageMeta(seg.text)?.src || 'src unavailable' }}</code>
                </div>
                <figcaption>原文</figcaption>
                <pre class="asset-source" v-html="renderSeg(seg)"></pre>
              </figure>
              <div v-else-if="seg.kind === 'formula'" class="asset-formula-body">
                <pre class="asset-source formula-source" v-html="renderSeg(seg)"></pre>
                <div v-if="seg.formula" class="formula-profile">
                  <p class="formula-meaning">{{ seg.formula.composition.meaning }}</p>
                  <div v-if="seg.formula.parameters.length" class="formula-section">
                    <h4>参数</h4>
                    <dl>
                      <template v-for="p in seg.formula.parameters" :key="p.symbol">
                        <dt>{{ p.symbol }}<span v-if="p.label"> · {{ p.label }}</span></dt>
                        <dd>
                          {{ p.meaning }}
                          <span v-if="p.unit"> · unit: {{ p.unit }}</span>
                          <span v-if="p.domain"> · domain: {{ p.domain }}</span>
                        </dd>
                      </template>
                    </dl>
                  </div>
                  <div v-if="seg.formula.context_links.length" class="formula-section">
                    <h4>上下文关系</h4>
                    <ul>
                      <li v-for="link in seg.formula.context_links" :key="`${link.target_lid}:${link.relation}`">
                        <strong>{{ link.relation }}</strong> {{ link.description }}
                      </li>
                    </ul>
                  </div>
                </div>
                <p v-else class="formula-empty">未找到公式语义剖面。</p>
              </div>
            </section>
            <!-- 高亮卡:该段全部高亮,删除 / 改范围(移除后重选)。 -->
            <div v-for="h in highlightsOf(seg.lid)" :key="h.mem_id" class="hl-card">
              <span class="hl-ex">🖍 {{ hlExcerpt(h) }}</span>
              <span class="hl-actions">
                <button class="note-btn" title="改范围(移除后重选)" @click="modifyHighlight(h)">✎ 改</button>
                <button class="note-btn del" title="删除高亮" @click="deleteHighlight(h)">🗑</button>
              </span>
            </div>
            <!-- 笔记卡:渲染 Markdown + LaTeX,带编辑/删除。 -->
            <div v-for="note in notesOf(seg.lid)" :key="note.mem_id" class="note-card">
              <div class="note-md md" v-html="renderMarkdown(note.content)"></div>
              <div class="note-actions">
                <button class="note-btn" title="编辑" @click="openEditNote(note)">✎ 编辑</button>
                <button class="note-btn del" title="删除" @click="deleteNote(note)">🗑 删除</button>
              </div>
            </div>
          </div>
          <p v-if="segments.length === 0" class="empty">
            （无内容——确认 server 已加载真书目录并在 8787 监听）
          </p>
        </article>
      </main>

      <!-- agent 对话区(分屏右半)-->
      <aside class="agent">
        <div class="agent-head">
          <h3>📚 书 agent</h3>
          <button class="new-chat" @click="newChat">＋ 新对话</button>
        </div>

        <div class="transcript">
          <div v-for="(turn, ti) in chat" :key="ti" class="turn">
            <p class="u-msg">🧑 {{ turn.user }}</p>

            <p v-if="turn.pending" class="pending">⏳ agent 思考中…</p>
            <p v-else-if="turn.error" class="incomplete">{{ turn.error }}</p>

            <div v-else-if="turn.outcome" class="a-msg">
              <!-- agent 答案渲染 Markdown + LaTeX(v-html 安全:renderMarkdown 经 markdown-it html:false 转义)。 -->
              <div
                v-if="turn.outcome.answer"
                class="ans-text md"
                v-html="renderMarkdown(turn.outcome.answer)"
              ></div>
              <p v-else class="ans-text">(无回答)</p>
              <p v-if="turn.outcome.incomplete" class="incomplete">
                ⚠ 未尽({{ turn.outcome.warning ?? "incomplete" }})
              </p>

              <!-- 可撤销提议卡 -->
              <div v-if="turn.outcome.effects.length" class="proposals">
                <p class="prop-h">本回合改动(可撤销):</p>
                <div v-for="(eff, ei) in turn.outcome.effects" :key="ei" class="proposal">
                  <span class="prop-label">{{ effLabel(eff) }}</span>
                  <template v-if="effState(ti, ei)">
                    <span class="done">{{ effState(ti, ei) }}</span>
                  </template>
                  <template v-else>
                    <button v-if="isGoto(eff)" @click="undoEffect(ti, ei, eff)">
                      ↩ 返回 {{ gotoBack(eff) }}
                    </button>
                    <template v-else>
                      <button @click="keepEffect(ti, ei, eff)">保留</button>
                      <button class="undo" @click="undoEffect(ti, ei, eff)">撤销</button>
                    </template>
                  </template>
                </div>
              </div>

              <!-- 查询踪迹(可折叠)-->
              <div v-if="turn.outcome.trace.length" class="trace">
                <button class="trace-toggle" @click="showTrace[ti] = !showTrace[ti]">
                  🔍 查询踪迹（{{ turn.outcome.trace.length }} 步）{{ showTrace[ti] ? "▲" : "▼" }}
                </button>
                <ol v-if="showTrace[ti]">
                  <li v-for="(t, i) in turn.outcome.trace" :key="i">
                    <code>{{ t.tool }}</code>
                    <span class="t-args">{{ t.args }}</span>
                    <span class="t-res">→ {{ t.result_digest }}</span>
                  </li>
                </ol>
              </div>

              <!-- 凝练成笔记 / 丢弃 -->
              <div class="distill" v-if="turn.outcome.answer">
                <button v-if="!turn.distilled" @click="distill(turn)">✍ 凝练成笔记</button>
                <span v-else class="done">已存为笔记</span>
              </div>
            </div>
          </div>

          <p v-if="chat.length === 0" class="empty">问这本书任何问题——agent 会检索、翻页、标注,所有动作可撤销。</p>
        </div>

        <div class="agent-input">
          <textarea
            v-model="agentInput"
            rows="3"
            placeholder="基于当前阅读位置问 agent…"
            @keydown.ctrl.enter="sendAgent"
          />
          <button :disabled="sending || !agentInput.trim()" @click="sendAgent">
            {{ sending ? "…" : "发送 (Ctrl+Enter)" }}
          </button>
        </div>
      </aside>
    </div>

    <!-- 段内自由高亮:选区浮动按钮(mousedown.prevent 防点击前清掉选区) -->
    <div
      v-if="hlPopover"
      class="hl-popover"
      :style="{ left: hlPopover.x + 'px', top: hlPopover.y - 40 + 'px' }"
    >
      <button @mousedown.prevent="confirmHighlight">🖍 高亮选区</button>
    </div>

    <!-- 笔记编辑器(模态 + 实时 MD/LaTeX 预览) -->
    <div v-if="noteEditor" class="note-modal" @click.self="cancelNote">
      <div class="note-dialog">
        <div class="nd-head">
          <span>{{ noteEditor.memId ? "✎ 编辑笔记" : "📝 新建笔记" }} · {{ noteEditor.lid }}</span>
          <button class="nd-close" title="关闭" @click="cancelNote">✕</button>
        </div>
        <div class="nd-body">
          <textarea
            v-model="noteEditor.content"
            class="nd-input"
            placeholder="支持 Markdown 与 LaTeX：**粗体**、- 列表、$E=mc^2$、$$\int$$ …"
            @keydown.ctrl.enter="saveNote"
          ></textarea>
          <div class="nd-preview md" v-html="notePreview"></div>
        </div>
        <div class="nd-foot">
          <span class="nd-hint">Ctrl+Enter 保存 · Markdown/LaTeX 实时预览</span>
          <span class="nd-actions">
            <button @click="cancelNote">取消</button>
            <button class="primary" :disabled="!noteEditor.content.trim()" @click="saveNote">保存</button>
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
.distill {
  margin-top: 0.5em;
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

/* 段内高亮的选区浮动按钮 */
.hl-popover {
  position: fixed;
  transform: translateX(-50%);
  z-index: 50;
}
.hl-popover button {
  background: #1a1a1a;
  color: #fff;
  border: none;
  border-radius: 5px;
  padding: 0.3rem 0.7rem;
  font-size: 0.85rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  cursor: pointer;
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
