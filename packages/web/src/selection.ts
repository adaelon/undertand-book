// 选区 → markdown 源文本还原。
// 现状 onProseMouseUp 用 range.toString() 拿到的是 KaTeX 渲染后 DOM 的纯文本:正文里的
// $...$ 已被 renderInlineMarkdown 换成 KaTeX 的 MathML+HTML 双表达 DOM,toString 把一个
// 公式摊成几份重复噪声(形如 \rho=0.05\rho=0.05ρ=0.05),进 note 引用块 / Ask AI 引用文本后
// 就再也渲染不出公式。KaTeX DOM 里其实保留了原始 LaTeX(在 <annotation encoding="application/x-tex">),
// 这里 cloneContents 拿到边界已裁剪好的选区片段,递归遍历遇 .katex 原子取回 LaTeX 包 $...$,其余
// 取文本——让 quote 从源头带 $...$,后续 renderMarkdown 自然能渲染出公式。
//
// 注意:高亮 range 的 LID/offset 映射在 App.selectionRanges 里完成。公式已是独立 LID,
// 那边会把公式按原子 leaf 处理,不再用 KaTeX DOM textContent 当 book.text 偏移。
export function rangeToMarkdown(range: Range): string {
  return fragmentToMarkdown(range.cloneContents()).replace(/\u00a0/g, " ").trim();
}

function fragmentToMarkdown(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? "";
  // DocumentFragment(nodeType 11)是 cloneContents 的根:不是 Element 但有 childNodes,
  // 必须遍历其子节点,否则整个选区被丢弃、rangeToMarkdown 永远返回空 → popover 不弹。
  const el = node.nodeType === node.ELEMENT_NODE ? (node as Element) : null;
  // 原子化:不深入 katex 内部(MathML + HTML 双表达),只取语义层的原始 LaTeX。
  if (el?.classList?.contains("katex")) {
    const a = el.querySelector('annotation[encoding="application/x-tex"]');
    const latex = (a?.textContent ?? el.textContent ?? "").trim();
    return latex ? `$${latex}$` : (el.textContent ?? "");
  }
  const isBlock = el ? /^(P|DIV|SECTION)$/.test(el.tagName) : false;
  let s = "";
  for (const c of Array.from(node.childNodes)) s += fragmentToMarkdown(c);
  if (isBlock && s && !/[ \n]$/.test(s)) s += " ";
  return s;
}
