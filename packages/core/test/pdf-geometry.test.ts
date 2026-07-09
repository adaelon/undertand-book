import { describe, expect, it } from "vitest";
import { extractPdfTextGeometry } from "../src/pdf-geometry";

function asciiBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function simplePdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 100 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${asciiBytes(stream).length} >>\nstream\n${stream}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(asciiBytes(pdf).length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = asciiBytes(pdf).length;
  pdf += "xref\n0 6\n";
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return asciiBytes(pdf);
}

describe("PH2 PDF text geometry adapter", () => {
  it("extracts page metadata, chars, words, and lines from a born-digital PDF", async () => {
    const geometry = await extractPdfTextGeometry(simplePdf("Hello PDF"));

    expect(geometry.pages).toHaveLength(1);
    const page = geometry.pages[0];
    expect(page).toMatchObject({
      pageIndex: 0,
      width: 300,
      height: 200,
      rotate: 0,
      view: [0, 0, 300, 200],
    });
    expect(page.chars.map((c) => c.text).join("")).toBe("Hello PDF");
    expect(page.words.map((w) => w.text)).toEqual(["Hello", "PDF"]);
    expect(page.lines.map((l) => l.text)).toEqual(["Hello PDF"]);
    expect(page.chars[0].bbox[0]).toBeGreaterThanOrEqual(72);
    expect(page.chars[0].bbox[1]).toBeGreaterThanOrEqual(100);
    expect(page.chars[0].bbox[2]).toBeGreaterThan(page.chars[0].bbox[0]);
    expect(page.chars[0].bbox[3]).toBeGreaterThan(page.chars[0].bbox[1]);
  });
});
