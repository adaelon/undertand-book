// agent 答案的 Markdown + LaTeX 渲染。
// 安全:html:false ⇒ 转义 LLM 输出里的原始 HTML(防 XSS);KaTeX 输出由插件自身规则注入,可信。
// 数学:$...$ 行内 / $$...$$ 独立公式(@traptitech/markdown-it-katex,throwOnError 关闭=语法错时显红字不崩)。
import MarkdownIt from "markdown-it";
import katex from "@traptitech/markdown-it-katex";

const md = new MarkdownIt({
  html: false, // 不放行原始 HTML(XSS 防线)
  linkify: true, // 裸 URL 自动成链
  breaks: true, // 单换行 → <br>,贴合聊天气泡
});
md.use(katex, { throwOnError: false });

/** 把 agent 答案文本渲染成 HTML(供 v-html)。空串安全。 */
export function renderMarkdown(src: string | null | undefined): string {
  return md.render(src ?? "");
}
