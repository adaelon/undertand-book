import { latexParser } from "latex-utensils";

export const FORMULA_SOURCE_AST_POLICY = {
  version: "formula_source_ast.v1",
} as const;

export type FormulaSourceNodeCategory =
  | "visible_character"
  | "transparent_wrapper"
  | "layout_control"
  | "glyph_transform"
  | "structural_relation"
  | "unknown_command"
  | "unsupported_structure";

export interface FormulaSourceAstNode {
  kind: "character" | "command" | "group" | "script" | "delimiter" | "structural";
  source_span: { start: number; end: number };
  category: FormulaSourceNodeCategory;
  value?: string;
  command?: string;
  relation?: "superscript" | "subscript";
  node_kind?: string;
  children?: FormulaSourceAstNode[];
  arguments?: FormulaSourceAstNode[][];
}

export interface FormulaVisibleToken {
  kind: "character" | "whitespace";
  value: string;
  source_span: { start: number; end: number };
}

export interface FormulaSourceAstResult {
  version: typeof FORMULA_SOURCE_AST_POLICY.version;
  status: "parsed" | "unsupported" | "invalid";
  delimiter: "inline" | "display" | null;
  source_span: { start: number; end: number };
  projectable: boolean;
  nodes: FormulaSourceAstNode[];
  visible_tokens: FormulaVisibleToken[];
  reason?: string;
}

const TRANSPARENT_WRAPPERS = new Set([
  "underline", "text", "textrm", "textit", "textbf", "mathrm", "mathbf", "mathit",
  "mathsf", "mathtt", "mathbb", "mathcal", "operatorname", "boldsymbol", "bm", "pmb",
]);

const TEXT_MODE_WRAPPERS = new Set(["text", "textrm", "textit", "textbf"]);

const LAYOUT_CONTROLS = new Set([
  "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "left", "right", "limits",
  "nolimits", "quad", "qquad", "big", "Big", "bigg", "Bigg", "middle",
]);

const GLYPH_TRANSFORMS = new Set([
  "frac", "dfrac", "tfrac", "sqrt", "sum", "prod", "int", "iint", "iiint", "oint",
  "underbrace", "overbrace", "overline", "hat", "widehat", "bar", "vec", "tilde", "widetilde",
  "accent", "overset", "underset", "stackrel", "binom", "matrix", "cases",
]);

type LatexNode = latexParser.Node;
type ParseMode = "math" | "text";

interface BuiltNodes {
  nodes: FormulaSourceAstNode[];
  tokens: FormulaVisibleToken[];
  projectable: boolean;
  unsupported: string[];
}

function absoluteSpan(
  location: latexParser.Location,
  sourceStart: number,
): { start: number; end: number } {
  return {
    start: sourceStart + location.start.offset,
    end: sourceStart + location.end.offset,
  };
}

function nodeLocation(node: LatexNode): latexParser.Location | undefined {
  return "location" in node ? node.location : undefined;
}

function characterTokens(
  value: string,
  relativeStart: number,
  sourceStart: number,
): FormulaVisibleToken[] {
  const tokens: FormulaVisibleToken[] = [];
  let offset = relativeStart;
  for (const character of value) {
    tokens.push({
      kind: "character",
      value: character,
      source_span: { start: sourceStart + offset, end: sourceStart + offset + character.length },
    });
    offset += character.length;
  }
  return tokens;
}

function whitespaceToken(
  sourceStart: number,
  relativeStart: number,
  relativeEnd: number,
): FormulaVisibleToken {
  return {
    kind: "whitespace",
    value: " ",
    source_span: { start: sourceStart + relativeStart, end: sourceStart + relativeEnd },
  };
}

function mergeBuilt(parts: BuiltNodes[]): BuiltNodes {
  return {
    nodes: parts.flatMap((part) => part.nodes),
    tokens: parts.flatMap((part) => part.tokens),
    projectable: parts.every((part) => part.projectable),
    unsupported: parts.flatMap((part) => part.unsupported),
  };
}

function buildNodeList(
  raw: string,
  nodes: LatexNode[],
  mode: ParseMode,
  bounds: { start: number; end: number },
  sourceStart: number,
): BuiltNodes {
  const parts: BuiltNodes[] = [];
  let previousEnd = bounds.start;
  for (const node of nodes) {
    if (node.kind === "space" || node.kind === "softbreak") {
      continue;
    }
    const location = nodeLocation(node);
    if (mode === "text" && location && location.start.offset > previousEnd
      && /^\s+$/u.test(raw.slice(previousEnd, location.start.offset))) {
      parts.push({
        nodes: [],
        tokens: [whitespaceToken(sourceStart, previousEnd, location.start.offset)],
        projectable: true,
        unsupported: [],
      });
    }
    parts.push(buildNode(raw, node, mode, sourceStart));
    if (location) previousEnd = location.end.offset;
  }
  if (mode === "text" && bounds.end > previousEnd && /^\s+$/u.test(raw.slice(previousEnd, bounds.end))) {
    parts.push({
      nodes: [],
      tokens: [whitespaceToken(sourceStart, previousEnd, bounds.end)],
      projectable: true,
      unsupported: [],
    });
  }
  return mergeBuilt(parts);
}

function buildArguments(
  raw: string,
  args: Array<latexParser.Group | latexParser.OptionalArg>,
  mode: ParseMode,
  sourceStart: number,
): BuiltNodes[] {
  return args.map((argument) => buildNodeList(raw, argument.content, mode, {
    start: argument.location.start.offset + 1,
    end: Math.max(argument.location.start.offset + 1, argument.location.end.offset - 1),
  }, sourceStart));
}

function commandNode(
  node: latexParser.Command | latexParser.AmsMathTextCommand,
  raw: string,
  mode: ParseMode,
  sourceStart: number,
): BuiltNodes {
  const command = node.kind === "command.text" ? "text" : node.name;
  const category: FormulaSourceNodeCategory = TRANSPARENT_WRAPPERS.has(command)
    ? "transparent_wrapper"
    : LAYOUT_CONTROLS.has(command)
      ? "layout_control"
      : GLYPH_TRANSFORMS.has(command)
        ? "glyph_transform"
        : "unknown_command";
  const childMode = TEXT_MODE_WRAPPERS.has(command) ? "text" : mode;
  const args = node.kind === "command.text" ? [node.arg] : node.args;
  const argumentParts = buildArguments(raw, args, childMode, sourceStart);
  const children = argumentParts.flatMap((part) => part.nodes);
  const wrapperArityValid = category !== "transparent_wrapper" || args.length === 1;
  const ownProjectable = (category === "transparent_wrapper" && wrapperArityValid)
    || category === "layout_control";
  const unsupported = category === "unknown_command"
    ? [`unknown formula command: ${command}`]
    : category === "transparent_wrapper" && !wrapperArityValid
      ? [`transparent formula wrapper has invalid arguments: ${command}`]
      : [];
  return {
    nodes: [{
      kind: "command",
      command,
      category,
      source_span: absoluteSpan(node.location, sourceStart),
      children,
      arguments: argumentParts.map((part) => part.nodes),
    }],
    tokens: argumentParts.flatMap((part) => part.tokens),
    projectable: ownProjectable && argumentParts.every((part) => part.projectable),
    unsupported: [...unsupported, ...argumentParts.flatMap((part) => part.unsupported)],
  };
}

function buildNode(
  raw: string,
  node: LatexNode,
  mode: ParseMode,
  sourceStart: number,
): BuiltNodes {
  if (node.kind === "command" || node.kind === "command.text") {
    return commandNode(node, raw, mode, sourceStart);
  }
  if (node.kind === "math.character" || node.kind === "text.string") {
    if (!node.location) {
      return { nodes: [], tokens: [], projectable: false, unsupported: ["visible formula token has no source location"] };
    }
    const tokens = characterTokens(node.content, node.location.start.offset, sourceStart);
    return {
      nodes: tokens.map((token) => ({
        kind: "character",
        category: "visible_character",
        value: token.value,
        source_span: token.source_span,
      })),
      tokens,
      projectable: true,
      unsupported: [],
    };
  }
  if (node.kind === "arg.group" || node.kind === "arg.optional") {
    const children = buildNodeList(raw, node.content, mode, {
      start: node.location.start.offset + 1,
      end: Math.max(node.location.start.offset + 1, node.location.end.offset - 1),
    }, sourceStart);
    return {
      ...children,
      nodes: [{
        kind: "group",
        category: "structural_relation",
        source_span: absoluteSpan(node.location, sourceStart),
        children: children.nodes,
      }],
    };
  }
  if (node.kind === "superscript" || node.kind === "subscript") {
    const child = node.arg ? buildNode(raw, node.arg, mode, sourceStart) : {
      nodes: [], tokens: [], projectable: false, unsupported: [`${node.kind} has no argument`],
    };
    return {
      ...child,
      nodes: [{
        kind: "script",
        category: "structural_relation",
        relation: node.kind,
        source_span: absoluteSpan(node.location, sourceStart),
        children: child.nodes,
      }],
    };
  }
  if (node.kind === "math.matching_delimiters" || node.kind === "math.math_delimiters") {
    const children = buildNodeList(raw, node.content, mode, {
      start: node.location.start.offset,
      end: node.location.end.offset,
    }, sourceStart);
    return {
      ...children,
      nodes: [{
        kind: "delimiter",
        category: "layout_control",
        source_span: absoluteSpan(node.location, sourceStart),
        children: children.nodes,
      }],
    };
  }
  const location = nodeLocation(node);
  const nodeKind = node.kind;
  return {
    nodes: location ? [{
      kind: "structural",
      category: "unsupported_structure",
      node_kind: nodeKind,
      source_span: absoluteSpan(location, sourceStart),
    }] : [],
    tokens: [],
    projectable: false,
    unsupported: [`unsupported formula AST node: ${nodeKind}`],
  };
}

function invalidResult(
  span: { start: number; end: number },
  reason: string,
): FormulaSourceAstResult {
  return {
    version: FORMULA_SOURCE_AST_POLICY.version,
    status: "invalid",
    delimiter: null,
    source_span: { ...span },
    projectable: false,
    nodes: [],
    visible_tokens: [],
    reason,
  };
}

export function parseFormulaSourceAst(
  source: string,
  span: { start: number; end: number },
): FormulaSourceAstResult {
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)
    || span.start < 0 || span.end <= span.start || span.end > source.length) {
    return invalidResult(span, "formula source span is invalid");
  }
  const raw = source.slice(span.start, span.end);
  let ast: latexParser.LatexAst;
  try {
    ast = latexParser.parse(raw, { enableMathCharacterLocation: true });
  } catch {
    return invalidResult(span, "formula source is not a closed LaTeX AST");
  }
  if (ast.kind !== "ast.root" || ast.content.length !== 1
    || (ast.content[0].kind !== "inlineMath" && ast.content[0].kind !== "displayMath")) {
    return invalidResult(span, "formula source must contain exactly one outer math node");
  }
  const formula = ast.content[0];
  if (formula.location.start.offset !== 0 || formula.location.end.offset !== raw.length) {
    return invalidResult(span, "formula source contains content outside the outer math node");
  }
  const delimiter = formula.kind === "displayMath" ? "display" : "inline";
  const delimiterLength = delimiter === "display" ? 2 : 1;
  const built = buildNodeList(raw, formula.content, "math", {
    start: delimiterLength,
    end: raw.length - delimiterLength,
  }, span.start);
  const unknown = built.unsupported.find((reason) => reason.startsWith("unknown formula command:"));
  const status = unknown || built.unsupported.length ? "unsupported" : "parsed";
  const projectable = status === "parsed" && built.projectable && built.tokens.some((token) => token.kind === "character");
  const reason = unknown
    ?? built.unsupported[0]
    ?? (!built.projectable ? "formula AST contains glyph-generating or reordering structure" : undefined)
    ?? (!projectable ? "formula AST has no visible character tokens" : undefined);
  return {
    version: FORMULA_SOURCE_AST_POLICY.version,
    status,
    delimiter,
    source_span: { ...span },
    projectable,
    nodes: built.nodes,
    visible_tokens: built.tokens,
    ...(reason ? { reason } : {}),
  };
}
