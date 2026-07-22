import { getDocument, OPS, VerbosityLevel } from "pdfjs-dist/legacy/build/pdf.mjs";

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

export interface PdfGeometryObject extends PdfGeometryRect {
  objectIndex: number;
  kind: "image_xobject" | "inline_image" | "image_mask" | "form_xobject";
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
  objects?: PdfGeometryObject[];
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

type PdfMatrix = [number, number, number, number, number, number];
type PdfBbox = [number, number, number, number];

interface PdfOperatorList {
  fnArray: ArrayLike<number>;
  argsArray: unknown[][];
}

interface ActiveForm {
  saved_matrix: PdfMatrix;
  explicit_bbox: PdfBbox | null;
  drawn_bboxes: PdfBbox[];
  has_nested_object: boolean;
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

function numericArray(value: unknown, length?: number): number[] | null {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return null;
  const numbers = Array.from(value as ArrayLike<number>);
  if (length !== undefined && numbers.length !== length) return null;
  return numbers.every(Number.isFinite) ? numbers : null;
}

function matrixProduct(left: PdfMatrix, right: PdfMatrix): PdfMatrix {
  return [
    left[0] * right[0] + left[2] * right[1],
    left[1] * right[0] + left[3] * right[1],
    left[0] * right[2] + left[2] * right[3],
    left[1] * right[2] + left[3] * right[3],
    left[0] * right[4] + left[2] * right[5] + left[4],
    left[1] * right[4] + left[3] * right[5] + left[5],
  ];
}

function transformedBbox(bbox: PdfBbox, matrix: PdfMatrix): PdfBbox {
  const point = (x: number, y: number): [number, number] => ([
    x * matrix[0] + y * matrix[2] + matrix[4],
    x * matrix[1] + y * matrix[3] + matrix[5],
  ]);
  const points = [
    point(bbox[0], bbox[1]),
    point(bbox[0], bbox[3]),
    point(bbox[2], bbox[1]),
    point(bbox[2], bbox[3]),
  ];
  return [
    Math.min(...points.map(([x]) => x)),
    Math.min(...points.map(([, y]) => y)),
    Math.max(...points.map(([x]) => x)),
    Math.max(...points.map(([, y]) => y)),
  ];
}

function validObjectBbox(bbox: PdfBbox): boolean {
  return bbox.every(Number.isFinite) && bbox[2] > bbox[0] && bbox[3] > bbox[1];
}

function extractOperatorObjects(operatorList: PdfOperatorList, pageIndex: number): PdfGeometryObject[] {
  const objects: PdfGeometryObject[] = [];
  const graphicsStack: PdfMatrix[] = [];
  const formStack: ActiveForm[] = [];
  let matrix: PdfMatrix = [1, 0, 0, 1, 0, 0];
  const addObject = (kind: PdfGeometryObject["kind"], bbox: PdfBbox) => {
    if (!validObjectBbox(bbox)) return;
    objects.push({ pageIndex, objectIndex: objects.length, kind, bbox });
    for (const form of formStack) {
      form.drawn_bboxes.push(bbox);
      form.has_nested_object = true;
    }
  };
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index] ?? [];
    if (fn === OPS.save) {
      graphicsStack.push([...matrix]);
      continue;
    }
    if (fn === OPS.restore) {
      matrix = graphicsStack.pop() ?? matrix;
      continue;
    }
    if (fn === OPS.transform) {
      const next = numericArray(args, 6);
      if (next) matrix = matrixProduct(matrix, next as PdfMatrix);
      continue;
    }
    if (fn === OPS.paintFormXObjectBegin) {
      const formMatrix = numericArray(args[0], 6) as PdfMatrix | null;
      const formBbox = numericArray(args[1], 4) as PdfBbox | null;
      const savedMatrix = [...matrix] as PdfMatrix;
      if (formMatrix) matrix = matrixProduct(matrix, formMatrix);
      formStack.push({
        saved_matrix: savedMatrix,
        explicit_bbox: formBbox ? transformedBbox(formBbox, matrix) : null,
        drawn_bboxes: [],
        has_nested_object: false,
      });
      continue;
    }
    if (fn === OPS.paintFormXObjectEnd) {
      const form = formStack.pop();
      if (!form) continue;
      const bbox = form.drawn_bboxes.length ? rectUnion(form.drawn_bboxes) : form.explicit_bbox;
      matrix = form.saved_matrix;
      if (bbox && !form.has_nested_object && validObjectBbox(bbox)) {
        objects.push({ pageIndex, objectIndex: objects.length, kind: "form_xobject", bbox });
        for (const parent of formStack) {
          parent.drawn_bboxes.push(bbox);
          parent.has_nested_object = true;
        }
      }
      continue;
    }
    if (fn === OPS.constructPath && formStack.length) {
      const pathBbox = numericArray(args[2], 4) as PdfBbox | null;
      if (pathBbox) {
        const bbox = transformedBbox(pathBbox, matrix);
        if (validObjectBbox(bbox)) formStack.at(-1)!.drawn_bboxes.push(bbox);
      }
      continue;
    }
    if (fn === OPS.paintImageXObject) {
      addObject("image_xobject", transformedBbox([0, 0, 1, 1], matrix));
      continue;
    }
    if (fn === OPS.paintInlineImageXObject) {
      addObject("inline_image", transformedBbox([0, 0, 1, 1], matrix));
      continue;
    }
    if (fn === OPS.paintImageMaskXObject || fn === OPS.paintSolidColorImageMask) {
      addObject("image_mask", transformedBbox([0, 0, 1, 1], matrix));
      continue;
    }
    if (fn === OPS.paintImageXObjectRepeat || fn === OPS.paintImageMaskXObjectRepeat) {
      const scaleX = typeof args[1] === "number" ? args[1] : null;
      const scaleY = typeof args[2] === "number" ? args[2] : null;
      const positions = numericArray(args[3]);
      if (scaleX === null || scaleY === null || !positions || positions.length % 2) continue;
      for (let position = 0; position < positions.length; position += 2) {
        const repeated = matrixProduct(matrix, [
          scaleX, 0, 0, scaleY, positions[position], positions[position + 1],
        ]);
        addObject(
          fn === OPS.paintImageXObjectRepeat ? "image_xobject" : "image_mask",
          transformedBbox([0, 0, 1, 1], repeated),
        );
      }
      continue;
    }
    if (fn === OPS.paintInlineImageXObjectGroup) {
      const group = Array.isArray(args[1]) ? args[1] : [];
      for (const entry of group) {
        if (!entry || typeof entry !== "object") continue;
        const transform = numericArray((entry as { transform?: unknown }).transform, 6) as PdfMatrix | null;
        if (!transform) continue;
        addObject("inline_image", transformedBbox([0, 0, 1, 1], matrixProduct(matrix, transform)));
      }
    }
  }
  return objects;
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
      const operatorList = await page.getOperatorList();
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
        objects: extractOperatorObjects(operatorList, pageNumber - 1),
      });
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}
