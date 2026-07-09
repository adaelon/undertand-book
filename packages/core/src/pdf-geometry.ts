import { getDocument, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfGeometryRect {
  pageIndex: number;
  bbox: [number, number, number, number];
}

export interface PdfGeometryChar extends PdfGeometryRect {
  charIndex: number;
  text: string;
}

export interface PdfGeometryWord extends PdfGeometryRect {
  wordIndex: number;
  text: string;
  char_start: number;
  char_end: number;
}

export interface PdfGeometryLine extends PdfGeometryRect {
  lineIndex: number;
  text: string;
  char_start: number;
  char_end: number;
}

export interface PdfGeometryPage {
  pageIndex: number;
  page_label?: string;
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  view: [number, number, number, number];
  chars: PdfGeometryChar[];
  words: PdfGeometryWord[];
  lines: PdfGeometryLine[];
}

export interface PdfTextGeometry {
  pages: PdfGeometryPage[];
}

interface PdfTextItem {
  str: string;
  dir: string;
  fontName: string;
  transform: number[];
  width: number;
  height: number;
  hasEOL: boolean;
}

function asPdfData(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
}

function isTextItem(item: unknown): item is PdfTextItem {
  if (!item || typeof item !== "object") return false;
  const v = item as Partial<PdfTextItem>;
  return typeof v.str === "string" && Array.isArray(v.transform) && typeof v.width === "number";
}

function rectUnion(rects: Array<[number, number, number, number]>): [number, number, number, number] {
  if (!rects.length) return [0, 0, 0, 0];
  let [x0, y0, x1, y1] = rects[0];
  for (const r of rects.slice(1)) {
    x0 = Math.min(x0, r[0]);
    y0 = Math.min(y0, r[1]);
    x1 = Math.max(x1, r[2]);
    y1 = Math.max(y1, r[3]);
  }
  return [x0, y0, x1, y1];
}

function textItemChars(item: PdfTextItem, pageIndex: number, startIndex: number): PdfGeometryChar[] {
  const chars = Array.from(item.str);
  if (!chars.length) return [];
  const x = item.transform[4] ?? 0;
  const y = item.transform[5] ?? 0;
  const width = item.width || 0;
  const height = Math.abs(item.height || item.transform[3] || 0);
  const charWidth = width / chars.length;
  return chars.map((text, offset) => {
    const x0 = x + charWidth * offset;
    const x1 = offset === chars.length - 1 ? x + width : x0 + charWidth;
    return {
      pageIndex,
      charIndex: startIndex + offset,
      text,
      bbox: [x0, y, x1, y + height],
    };
  });
}

function buildWords(pageIndex: number, chars: PdfGeometryChar[]): PdfGeometryWord[] {
  const words: PdfGeometryWord[] = [];
  let active: PdfGeometryChar[] = [];
  const flush = () => {
    if (!active.length) return;
    words.push({
      pageIndex,
      wordIndex: words.length,
      text: active.map((c) => c.text).join(""),
      char_start: active[0].charIndex,
      char_end: active[active.length - 1].charIndex + 1,
      bbox: rectUnion(active.map((c) => c.bbox)),
    });
    active = [];
  };
  for (const char of chars) {
    if (/\s/u.test(char.text)) flush();
    else active.push(char);
  }
  flush();
  return words;
}

function buildLines(pageIndex: number, textItems: PdfTextItem[], charsByItem: PdfGeometryChar[][]): PdfGeometryLine[] {
  const lines: PdfGeometryLine[] = [];
  let active: PdfGeometryChar[] = [];
  const flush = () => {
    if (!active.length) return;
    lines.push({
      pageIndex,
      lineIndex: lines.length,
      text: active.map((c) => c.text).join("").trimEnd(),
      char_start: active[0].charIndex,
      char_end: active[active.length - 1].charIndex + 1,
      bbox: rectUnion(active.map((c) => c.bbox)),
    });
    active = [];
  };
  for (let i = 0; i < textItems.length; i++) {
    active.push(...charsByItem[i]);
    if (textItems[i].hasEOL) flush();
  }
  flush();
  return lines;
}

function rotationOf(value: number): 0 | 90 | 180 | 270 {
  return value === 90 || value === 180 || value === 270 ? value : 0;
}

export async function extractPdfTextGeometry(data: Uint8Array | ArrayBuffer): Promise<PdfTextGeometry> {
  const task = getDocument({
    data: asPdfData(data),
    disableFontFace: true,
    useWorkerFetch: false,
    verbosity: VerbosityLevel.ERRORS,
  });
  const pdf = await task.promise;
  try {
    const labels = await pdf.getPageLabels().catch(() => null);
    const pages: PdfGeometryPage[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const textContent = await page.getTextContent({ includeMarkedContent: false });
      const items = textContent.items.filter((item): item is PdfTextItem => isTextItem(item));
      const charsByItem: PdfGeometryChar[][] = [];
      let charIndex = 0;
      for (const item of items) {
        const chars = textItemChars(item, pageNumber - 1, charIndex);
        charsByItem.push(chars);
        charIndex += chars.length;
      }
      const chars = charsByItem.flat();
      const viewport = page.getViewport({ scale: 1, rotation: 0 });
      pages.push({
        pageIndex: pageNumber - 1,
        ...(labels?.[pageNumber - 1] ? { page_label: labels[pageNumber - 1] } : {}),
        width: viewport.width,
        height: viewport.height,
        rotate: rotationOf(page.rotate),
        view: [page.view[0], page.view[1], page.view[2], page.view[3]],
        chars,
        words: buildWords(pageNumber - 1, chars),
        lines: buildLines(pageNumber - 1, items, charsByItem),
      });
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}
