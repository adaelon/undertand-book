<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "./api";
import type { AgentEffect, MemoryRecord, OuterOutcome, Viewport } from "./api";
import { renderMarkdown } from "./md";

// ── 阅读区会话态 ──
const leafOrder = ref<string[]>([]); // 全书叶 LID 序(读位感分母 + 进度)
const viewport = ref<Viewport | null>(null);
const segments = ref<{ lid: string; text: string }[]>([]); // 视口内连续正文(LID 隐形)
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

// 标注查询:某 lid 上是否有 highlight / 取其全部 note 记录(可多条)。
function isHighlighted(lid: string): boolean {
  return annotations.value.some((r) => r.anchor.lid === lid && r.type === "highlight");
}
function notesOf(lid: string): MemoryRecord[] {
  return annotations.value.filter((r) => r.anchor.lid === lid && r.type === "note");
}

// 笔记删除:memory.delete + 刷新标注。
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

// 笔记更新:mem_id 内容寻址 ⇒ 改内容 = 删旧 + 存新(同 anchor/type/layer)`[ADR-0026]`。
async function editNote(rec: MemoryRecord) {
  const next = window.prompt("编辑笔记(支持 Markdown / $公式$):", rec.content);
  if (next === null || next.trim() === "" || next === rec.content) return;
  try {
    banner.value = "";
    await api.delete(rec.mem_id);
    await api.save({
      type: "note",
      anchor_lid: rec.anchor.lid ?? "",
      content: next,
      layer: rec.layer,
    });
    await refreshAnnotations();
  } catch (e) {
    fail(e);
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
  segments.value = texts.map((t) => ({ lid: t.lid, text: t.text }));
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
async function doNote() {
  if (!selectedLid.value) return;
  const text = window.prompt(`给 ${selectedLid.value} 记笔记:`);
  if (!text) return;
  try {
    banner.value = "";
    await api.note(selectedLid.value, text);
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

        <article class="prose">
          <div v-for="seg in segments" :key="seg.lid" class="seg">
            <p
              :data-lid="seg.lid"
              :class="{
                anchor: seg.lid === viewport?.anchor_lid,
                selected: seg.lid === selectedLid,
                hl: isHighlighted(seg.lid),
              }"
              @click="selectedLid = seg.lid"
            >
              {{ seg.text }}
            </p>
            <!-- 笔记卡:渲染 Markdown + LaTeX,带编辑/删除。 -->
            <div v-for="note in notesOf(seg.lid)" :key="note.mem_id" class="note-card">
              <div class="note-md md" v-html="renderMarkdown(note.content)"></div>
              <div class="note-actions">
                <button class="note-btn" title="编辑" @click="editNote(note)">✎ 编辑</button>
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
</style>
