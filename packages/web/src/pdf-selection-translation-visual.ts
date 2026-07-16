import { createApp, defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { Highlighter, Languages, MessageSquareText, Sparkles, X } from "@lucide/vue";
import { ApiError } from "./api";
import { renderMarkdown } from "./md";
import { usePdfSelectionTranslation } from "./pdf-selection-translation";
import PdfSelectionTranslationSurface from "./components/PdfSelectionTranslationSurface.vue";
import "./style.css";
import "./pdf-selection-translation-visual.css";

const VisualHarness = defineComponent({
  setup() {
    const selection = ref<HTMLElement | null>(null);
    const anchorRect = ref({ left: 300, top: 640, right: 860, bottom: 680 });
    const copied = ref(false);
    const settingsOpened = ref(false);
    const mode = new URLSearchParams(window.location.search).get("mode");
    const controller = usePdfSelectionTranslation(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      if (mode === "error") {
        throw new ApiError(
          502,
          "TRANSLATION_PROVIDER_UNCONFIGURED",
          "provider",
          "Reader Provider is not configured",
        );
      }
      return {
        translation_markdown: "这是一段忠实译文，保留公式 $E=mc^2$ 与 **Markdown** 结构。",
        target_locale: "zh-CN" as const,
      };
    });
    const draft = {
      request_id: "visual-selection",
      status: "resolved" as const,
      raw_quote: "Cardiac alternative splicing preserves E=mc^2.",
      resolved_quote: "Cardiac alternative splicing preserves E=mc^2.",
      ranges: [{ lid: "1.1", range: { start: 0, end: 48 } }],
    };

    function measureSelection() {
      const rect = selection.value?.getBoundingClientRect();
      if (!rect) return;
      anchorRect.value = {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      };
    }

    onMounted(() => {
      measureSelection();
      window.addEventListener("resize", measureSelection);
    });
    onBeforeUnmount(() => window.removeEventListener("resize", measureSelection));

    const tool = (label: string, icon: typeof Highlighter, disabled: boolean, onClick?: () => void) =>
      h("button", { type: "button", disabled, "aria-label": label, onClick }, [
        h(icon, { size: 16, "aria-hidden": "true" }),
        h("span", label),
      ]);

    return () => {
      const state = controller.state.value;
      const loading = state.phase === "loading";
      return h("main", { class: "translation-visual" }, [
        h("header", { class: "translation-visual-header" }, "Paper Reader"),
        h("article", { class: "translation-paper" }, [
          h("div", { class: "translation-paper-copy" }, [
            h("p", "Alternative splicing is a regulated process that expands transcript diversity in cardiac tissue."),
            h("p", "The original paper remains the only citation source while the bilingual aid is ephemeral."),
          ]),
          h("p", { ref: selection, class: "translation-selection" }, draft.raw_quote),
        ]),
        h("div", { class: "translation-visual-toolbar", role: "toolbar", "aria-label": "PDF 选区操作" }, [
          tool("高亮", Highlighter, loading),
          tool("笔记", MessageSquareText, loading),
          tool("问 AI", Sparkles, loading),
          tool("翻译", Languages, loading, () => { void controller.start(draft); }),
          h("button", {
            type: "button",
            "aria-label": "关闭 PDF 选区操作",
            onClick: () => controller.invalidate("selection"),
          }, [h(X, { size: 16, "aria-hidden": "true" })]),
        ]),
        copied.value ? h("span", { class: "translation-visual-status" }, "copied") : null,
        settingsOpened.value ? h("span", { class: "translation-visual-status" }, "settings") : null,
        state.phase !== "idle"
          ? h(PdfSelectionTranslationSurface, {
            state,
            anchorRect: anchorRect.value,
            renderMarkdown,
            showSettings: true,
            onClose: () => controller.invalidate("close"),
            onRetry: () => { void controller.retry(); },
            onSettings: () => { settingsOpened.value = true; },
            onCopy: () => { copied.value = true; },
          })
          : null,
      ]);
    };
  },
});

createApp(VisualHarness).mount("#app");
