<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api, ApiError } from "./api";
import type { MemoryRecord, QueryResponse, Viewport } from "./api";

// ── 会话态 ──
const leafOrder = ref<string[]>([]); // 全书叶 LID 序(读位感分母 + 进度)
const viewport = ref<Viewport | null>(null);
const segments = ref<{ lid: string; text: string }[]>([]); // 视口内连续正文(LID 隐形)
const annotations = ref<MemoryRecord[]>([]); // 当前书全部标注(客户端按 lid 过滤)
const selectedLid = ref<string | null>(null);
const chapterTitle = ref<string>("");

// 问答态
const qInput = ref("");
const answer = ref<QueryResponse | null>(null);
const querying = ref(false);

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

// 标注查询:某 lid 上是否有 highlight / 取其 note 文本。
function isHighlighted(lid: string): boolean {
  return annotations.value.some((r) => r.anchor.lid === lid && r.type === "highlight");
}
function noteOf(lid: string): string | null {
  const n = annotations.value.find((r) => r.anchor.lid === lid && r.type === "note");
  return n ? n.content : null;
}

// 视口加载:逐 visible_lid 取真原文(连续正文),并刷新标注。
async function loadWindow(vp: Viewport) {
  viewport.value = vp;
  selectedLid.value = vp.anchor_lid;
  const texts = await Promise.all(vp.visible_lids.map((lid) => api.text(lid)));
  segments.value = texts.map((t) => ({ lid: t.lid, text: t.text }));
  annotations.value = await api.recall({}); // 单书:取全部,客户端按 lid 过滤
  await loadChapter(vp.anchor_lid);
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
    annotations.value = await api.recall({}); // 回显标注(单源 = 记忆层)
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
    annotations.value = await api.recall({});
  } catch (e) {
    fail(e);
  }
}

// ── 问答 ──
async function doQuery() {
  const q = qInput.value.trim();
  if (!q) return;
  querying.value = true;
  banner.value = "";
  try {
    // 读到哪问到哪:anchor 默认当前选区/视口锚(服务端缺省也会取 reader anchor)。
    answer.value = await api.query(q, selectedLid.value ?? viewport.value?.anchor_lid);
  } catch (e) {
    fail(e);
  } finally {
    querying.value = false;
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
          <p
            v-for="seg in segments"
            :key="seg.lid"
            :data-lid="seg.lid"
            :class="{
              anchor: seg.lid === viewport?.anchor_lid,
              selected: seg.lid === selectedLid,
              hl: isHighlighted(seg.lid),
            }"
            @click="selectedLid = seg.lid"
          >
            {{ seg.text }}
            <span v-if="noteOf(seg.lid)" class="note">📝 {{ noteOf(seg.lid) }}</span>
          </p>
          <p v-if="segments.length === 0" class="empty">
            （无内容——确认 server 已加载真书目录并在 8787 监听）
          </p>
        </article>
      </main>

      <!-- 问答区 -->
      <aside class="qa">
        <h3>问这本书</h3>
        <textarea v-model="qInput" rows="3" placeholder="基于当前阅读位置提问…" />
        <button :disabled="querying || !qInput.trim()" @click="doQuery">
          {{ querying ? "检索中…" : "提问" }}
        </button>

        <div v-if="answer" class="answer">
          <p class="ans-text">{{ answer.answer ?? "(无法作答)" }}</p>
          <p v-if="answer.incomplete" class="incomplete">
            ⚠ 证据不足({{ answer.warning ?? "incomplete" }})
          </p>
          <div v-if="answer.citations.length" class="cites">
            <p class="cites-h">引用(点击跳原文):</p>
            <ul>
              <li v-for="c in answer.citations" :key="c.lid">
                <a href="#" @click.prevent="doGoto(c.lid)">[{{ c.lid }}]</a>
                <span class="role">{{ c.role }}</span> {{ c.text }}
              </li>
            </ul>
          </div>
          <div v-if="answer.model_supplement.length" class="supp">
            <p class="supp-h">模型补充(无原文锚):</p>
            <p v-for="(s, i) in answer.model_supplement" :key="i">{{ s.text }}</p>
          </div>
          <p class="scope">检索范围: {{ answer.scope_used }}</p>
        </div>
      </aside>
    </div>
  </div>
</template>
