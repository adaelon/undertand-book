// PB5-1 bookId 通用化 [ADR-0042 决策7]。预构建工作区 `.understand-book/<bookId>/.build/`
// 的目录名由书路径文件名确定性派生 —— emit-input / build-status / pass1-batch 三处共用同一
// 派生(三处算同一 bookId 才找得到 `.build/`)。纯确定性、零文件 IO、零 LLM。
//
// 命门(承 [windows-cjk-path-tooling] + PB0 fail-fast):非 ASCII 主导 / slug 为空时**报错**
// 要显式 `--book-id`,绝不静默建 CJK / 空目录坏工具链。

/** 剥目录(`/` 与 `\`)+ 去掉最后一个扩展名。 */
function basenameNoExt(p: string): string {
  const base = p.split(/[/\\]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "");
}

/** ASCII-safe url 友好 slug:小写、空格/下划线/点→连字符、剥非 [a-z0-9-]、折叠并 trim 连字符。 */
function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** raw 中码点 > 127 的字符数。 */
function countNonAscii(raw: string): number {
  let n = 0;
  for (const ch of raw) if (ch.codePointAt(0)! > 127) n++;
  return n;
}

/** raw 中 [a-zA-Z0-9] 的字符数。 */
function countAsciiAlnum(raw: string): number {
  return (raw.match(/[a-zA-Z0-9]/g) ?? []).length;
}

/**
 * 从书路径派生构建工作区目录名 bookId。
 * @param bookPath 书文件路径(epub / md);取 basename 去扩展后 slug 化。
 * @param override `--book-id` 显式覆盖;给定时无视 bookPath,直接 slug 化 override。
 * @throws override slug 为空 / 默认派生时非 ASCII 主导或 slug 为空 —— 要求显式 `--book-id`。
 */
export function deriveBookId(bookPath: string, override?: string): string {
  if (override !== undefined) {
    const slug = slugify(override);
    if (!slug) throw new Error(`--book-id "${override}" slug 化后为空(需 ASCII 字母数字)`);
    return slug;
  }

  const raw = basenameNoExt(bookPath);
  const nonAscii = countNonAscii(raw);
  const asciiAlnum = countAsciiAlnum(raw);
  if (asciiAlnum === 0 || nonAscii > asciiAlnum) {
    throw new Error(
      `无法从文件名 "${raw}" 派生 ASCII bookId(非 ASCII 主导);请用 --book-id 显式指定`,
    );
  }

  const slug = slugify(raw);
  if (!slug) throw new Error(`文件名 "${raw}" slug 化后为空;请用 --book-id 显式指定`);
  return slug;
}
