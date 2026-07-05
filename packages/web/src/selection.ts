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
  return normalizeMarkdown(fragmentToMarkdown(range.cloneContents()));
}

function normalizeMarkdown(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function childrenToMarkdown(node: Node): string {
  return Array.from(node.childNodes).map(fragmentToMarkdown).join("");
}

function inlineChildrenToMarkdown(node: Node): string {
  return childrenToMarkdown(node).replace(/\s+/g, " ").trim();
}

function block(value: string): string {
  const trimmed = value.trim();
  return trimmed ? `${trimmed}\n\n` : "";
}

function wrapInline(marker: string, node: Node): string {
  const body = inlineChildrenToMarkdown(node);
  return body ? `${marker}${body}${marker}` : "";
}

function markdownTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr"))
    .map((tr) =>
      Array.from(tr.children)
        .filter((cell) => cell.tagName === "TH" || cell.tagName === "TD")
        .map((cell) => inlineChildrenToMarkdown(cell).replace(/\|/g, "\\|")),
    )
    .filter((row) => row.length > 0);
  if (!rows.length) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const filled = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
  const header = filled[0];
  const separator = Array(width).fill("---");
  const body = filled.slice(1);
  return block([header, separator, ...body].map((row) => `| ${row.join(" | ")} |`).join("\n"));
}

function listToMarkdown(list: Element, ordered: boolean): string {
  const items = Array.from(list.children).filter((child) => child.tagName === "LI");
  const lines = items.map((item, index) => {
    const marker = ordered ? `${index + 1}. ` : "- ";
    const content = normalizeMarkdown(childrenToMarkdown(item)).replace(/\n/g, "\n  ");
    return `${marker}${content}`;
  });
  return block(lines.join("\n"));
}

function katexToMarkdown(el: Element): string {
  const a = el.querySelector('annotation[encoding="application/x-tex"]');
  const latex = (a?.textContent ?? el.textContent ?? "").trim();
  if (!latex) return el.textContent ?? "";
  const display = !!el.closest(".katex-display");
  return display ? `\n\n$$${latex}$$\n\n` : `$${latex}$`;
}

function fragmentToMarkdown(node: Node): string {
  if (node.nodeType === node.TEXT_NODE) return node.textContent ?? "";
  // DocumentFragment(nodeType 11)是 cloneContents 的根:不是 Element 但有 childNodes,
  // 必须遍历其子节点,否则整个选区被丢弃、rangeToMarkdown 永远返回空 → popover 不弹。
  const el = node.nodeType === node.ELEMENT_NODE ? (node as Element) : null;
  if (!el) return childrenToMarkdown(node);

  // 原子化:不深入 katex 内部(MathML + HTML 双表达),只取语义层的原始 LaTeX。
  if (el.classList.contains("katex")) return katexToMarkdown(el);

  const tag = el.tagName;
  switch (tag) {
    case "BR":
      return "\n";
    case "STRONG":
    case "B":
      return wrapInline("**", el);
    case "EM":
    case "I":
      return wrapInline("*", el);
    case "CODE":
      if (el.closest("pre")) return el.textContent ?? "";
      return `\`${(el.textContent ?? "").replace(/`/g, "\\`")}\``;
    case "PRE":
      return block(`\`\`\`\n${el.textContent?.replace(/\n+$/g, "") ?? ""}\n\`\`\``);
    case "A": {
      const href = el.getAttribute("href");
      const text = inlineChildrenToMarkdown(el);
      return href ? `[${text || href}](${href})` : text;
    }
    case "BLOCKQUOTE":
      return block(normalizeMarkdown(childrenToMarkdown(el)).split("\n").map((line) => `> ${line}`).join("\n"));
    case "UL":
      return listToMarkdown(el, false);
    case "OL":
      return listToMarkdown(el, true);
    case "TABLE":
      return markdownTable(el);
    case "TR":
    case "THEAD":
    case "TBODY":
    case "TFOOT":
      return childrenToMarkdown(el);
    case "TH":
    case "TD":
      return inlineChildrenToMarkdown(el);
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return block(`${"#".repeat(Number(tag[1]))} ${inlineChildrenToMarkdown(el)}`);
    case "P":
    case "DIV":
    case "SECTION":
    case "ARTICLE":
      return block(childrenToMarkdown(el));
    case "LI":
      return normalizeMarkdown(childrenToMarkdown(el));
    default:
      return childrenToMarkdown(el);
  }
}
