// agent 答案的 Markdown + LaTeX 渲染。
// 安全:html:false ⇒ 转义 LLM 输出里的原始 HTML(防 XSS);KaTeX 输出由插件自身规则注入,可信。
// 数学:$...$ 行内 / $$...$$ 独立公式(@traptitech/markdown-it-katex,throwOnError 关闭=语法错时显红字不崩)。
// $$...$$ display math 插件要求独占行;用户/agent 常把 $$ 和文字挤在同一行(note、answer),
// 插件当场跳过不渲染。renderMarkdown 前做一道 normalizeDisplayMath:把内联 $$ 前后补换行规整成独占行,
// 不动已独占行的 $$、不动 $...$ 行内公式。
import MarkdownIt from "markdown-it";
import katex from "@traptitech/markdown-it-katex";

const md = new MarkdownIt({
  html: false, // 不放行原始 HTML(XSS 防线)
  linkify: true, // 裸 URL 自动成链
  breaks: true, // 单换行 → <br>,贴合聊天气泡
});
md.use(katex, { throwOnError: false });

/** 把内联 $$...$$ 规整成独占行,让 katex 插件识别为 display math。 */
function normalizeDisplayMath(src: string): string {
  return src.replace(/\$\$([^$]+)\$\$/g, (m, tex, offset, str) => {
    const before = offset > 0 ? str[offset - 1] : "\n";
    const afterEnd = offset + m.length;
    const after = afterEnd < str.length ? str[afterEnd] : "\n";
    const needBefore = before !== "\n" && before !== "\r";
    const needAfter = after !== "\n" && after !== "\r";
    return (needBefore ? "\n" : "") + "$$" + tex + "$$" + (needAfter ? "\n" : "");
  });
}

/** 把 agent 答案文本渲染成 HTML(供 v-html)。空串安全。 */
export function renderMarkdown(src: string | null | undefined): string {
  return md.render(normalizeDisplayMath(src ?? ""));
}
/** 渲染行内 Markdown/LaTeX,不包外层 <p>;用于 reader 段落正文。 */
export function renderInlineMarkdown(src: string | null | undefined): string {
  return md.renderInline(src ?? "");
}