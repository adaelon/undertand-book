import {
  parseFormulaSourceAst,
  type FormulaSourceAstNode,
} from "./formula-source-ast";

export const PDF_FORMULA_GLYPH_POLICY = {
  version: "pdf_formula_glyph_policy.v1",
} as const;

export interface FormulaGlyphToken {
  alternatives: string[];
  source_span: { start: number; end: number };
  groups: string[];
  forbidden_adjacent_keys?: string[];
}

export interface FormulaGlyphConstraint {
  kind: "above" | "right_of";
  first_group: string;
  second_group: string;
  optional_first_group?: boolean;
}

export interface FormulaGlyphPlanVariant {
  tokens: FormulaGlyphToken[];
}

export interface FormulaGlyphPlan {
  version: typeof PDF_FORMULA_GLYPH_POLICY.version;
  status: "supported" | "unsupported" | "invalid";
  variants: FormulaGlyphPlanVariant[];
  constraints: FormulaGlyphConstraint[];
  requires_geometry: boolean;
  reason?: string;
}

export interface FormulaGlyphCandidate {
  key: string;
  pageIndex: number;
  charIndex: number;
  bbox: [number, number, number, number];
}

export interface FormulaGlyphMatch {
  start: number;
  end: number;
  source_spans: Array<{ start: number; end: number }>;
  variant_index: number;
}

export interface FormulaGlyphMatchResult {
  matches: FormulaGlyphMatch[];
  key_candidate_count: number;
  geometry_rejection_count: number;
}

interface CompiledPart {
  variants: FormulaGlyphToken[][];
  constraints: FormulaGlyphConstraint[];
  anchor_group?: string;
  requires_geometry: boolean;
  unsupported: string[];
}

const TRANSPARENT_COMMANDS = new Set([
  "underline", "text", "textrm", "textit", "textbf", "mathrm", "mathbf", "mathit",
  "mathsf", "mathtt", "mathbb", "mathcal", "operatorname", "operatorname*", "boldsymbol",
  "bm", "pmb", "boxed",
]);

const LAYOUT_COMMANDS = new Set([
  "displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle", "left", "right", "limits",
  "nolimits", "quad", "qquad", "big", "Big", "bigg", "Bigg", "middle", ",", ":", ";", "!",
]);

const SYMBOL_COMMANDS: Record<string, string[]> = {
  alpha: ["α"], beta: ["β"], gamma: ["γ"], delta: ["δ"], Delta: ["Δ"],
  epsilon: ["ϵ", "ε"], varepsilon: ["ε", "ϵ"], eta: ["η"], theta: ["θ"],
  kappa: ["κ"], lambda: ["λ"], mu: ["μ"], pi: ["π"], rho: ["ρ"], sigma: ["σ"],
  Sigma: ["Σ"], tau: ["τ"], phi: ["ϕ", "φ"], varphi: ["φ", "ϕ"], chi: ["χ"],
  omega: ["ω"], Omega: ["Ω"], partial: ["∂"], nabla: ["∇"], top: ["⊤", "T"],
  dagger: ["†"], ast: ["∗", "*"], in: ["∈"], gtrsim: ["≳"], lesssim: ["≲"],
  gg: ["≫"], ll: ["≪"], subset: ["⊂"], subseteq: ["⊆"], supset: ["⊃"],
  supseteq: ["⊇"], otimes: ["⊗"], odot: ["⊙"], vdots: ["⋮"], langle: ["⟨"],
  rangle: ["⟩"], times: ["×"], cdot: ["·"], circ: ["°"], le: ["≤"], leq: ["≤"],
  ge: ["≥"], geq: ["≥"], neq: ["≠"], approx: ["≈"], sim: ["∼"], pm: ["±"],
  infty: ["∞"], sum: ["∑"], prod: ["∏"], int: ["∫"], iint: ["∬"], iiint: ["∭"],
  oint: ["∮"], to: ["→"], mapsto: ["↦"], forall: ["∀"], exists: ["∃"], mid: ["∣", "|"],
  bullet: ["•"], lfloor: ["⌊"], rfloor: ["⌋"], "|": ["∥"],
};

const NAMED_OPERATORS = new Set(["exp", "log", "max", "min", "arg", "diag", "tr"]);
const FRACTION_COMMANDS = new Set(["frac", "dfrac", "tfrac"]);
const ROOT_COMMANDS = new Set(["sqrt"]);
const LARGE_OPERATOR_COMMANDS = new Set(["sum", "prod", "int", "iint", "iiint", "oint"]);
const ACCENT_COMMANDS: Record<string, string[]> = {
  tilde: ["˜", "~"], widetilde: ["˜", "~"], hat: ["ˆ", "^"], widehat: ["ˆ", "^"],
  bar: ["¯"], vec: ["⃗", "→"], accent: ["ˆ"],
};
const VECTOR_ONLY_COMMANDS = new Set(["overline", "underbrace", "overbrace"]);

function formulaKey(value: string): string[] {
  const keys: string[] = [];
  for (const character of value.normalize("NFKC")) {
    if (/^[\u002d\u00ad\u2010\u2011]$/u.test(character)) keys.push("-");
    else keys.push(character);
  }
  return keys;
}

export function formulaGlyphKeys(value: string): string[] {
  return formulaKey(value);
}

function tokenAlternatives(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => {
    const keys = formulaKey(value);
    return keys.length === 1 ? keys : [];
  }))];
}

function cartesianAppend(
  left: FormulaGlyphToken[][],
  right: FormulaGlyphToken[][],
): FormulaGlyphToken[][] {
  const output: FormulaGlyphToken[][] = [];
  for (const leftVariant of left) {
    for (const rightVariant of right) {
      output.push([...leftVariant, ...rightVariant]);
      if (output.length >= 32) return output;
    }
  }
  return output;
}

function addGroup(variants: FormulaGlyphToken[][], group: string): FormulaGlyphToken[][] {
  return variants.map((variant) => variant.map((token) => ({
    ...token,
    groups: token.groups.includes(group) ? token.groups : [...token.groups, group],
  })));
}

function emptyPart(): CompiledPart {
  return { variants: [[]], constraints: [], requires_geometry: false, unsupported: [] };
}

function commandSourceSpan(
  source: string,
  node: FormulaSourceAstNode,
): { start: number; end: number } {
  const raw = source.slice(node.source_span.start, node.source_span.end);
  const match = /^\\(?:[A-Za-z]+\*?|.)/u.exec(raw);
  return match
    ? { start: node.source_span.start, end: node.source_span.start + match[0].length }
    : { ...node.source_span };
}

function commandNameSpans(
  source: string,
  node: FormulaSourceAstNode,
  value: string,
): FormulaGlyphToken[] {
  const span = commandSourceSpan(source, node);
  const raw = source.slice(span.start, span.end);
  const nameStart = raw.startsWith("\\") ? span.start + 1 : span.start;
  return Array.from(value).map((character, index) => ({
    alternatives: tokenAlternatives([character]),
    source_span: {
      start: Math.min(span.end, nameStart + index),
      end: Math.min(span.end, nameStart + index + 1),
    },
    groups: [],
  }));
}

function buildFormulaCompiler(source: string) {
  let groupCounter = 0;
  const nextGroup = (prefix: string) => `${prefix}-${groupCounter += 1}`;

  const compileList = (nodes: FormulaSourceAstNode[]): CompiledPart => {
    let output = emptyPart();
    let lastAnchor: string | undefined;
    for (const node of nodes) {
      if (node.kind === "script") {
        const child = compileList(node.children ?? []);
        const childGroup = nextGroup(node.relation ?? "script");
        child.variants = addGroup(child.variants, childGroup);
        if (lastAnchor && child.variants.some((variant) => variant.length)) {
          child.constraints.push({
            kind: "above",
            first_group: node.relation === "superscript" ? childGroup : lastAnchor,
            second_group: node.relation === "superscript" ? lastAnchor : childGroup,
          });
          child.requires_geometry = true;
        }
        output.variants = cartesianAppend(output.variants, child.variants);
        output.constraints.push(...child.constraints);
        output.requires_geometry ||= child.requires_geometry;
        output.unsupported.push(...child.unsupported);
        continue;
      }
      const part = compileNode(node);
      output.variants = cartesianAppend(output.variants, part.variants);
      output.constraints.push(...part.constraints);
      output.requires_geometry ||= part.requires_geometry;
      output.unsupported.push(...part.unsupported);
      if (part.anchor_group) lastAnchor = part.anchor_group;
    }
    const anchorGroup = output.variants.some((variant) => variant.length) ? nextGroup("sequence") : undefined;
    if (anchorGroup) output.variants = addGroup(output.variants, anchorGroup);
    output.anchor_group = anchorGroup;
    return output;
  };

  const compileArguments = (node: FormulaSourceAstNode): CompiledPart => (
    compileList(node.arguments?.flat() ?? node.children ?? [])
  );

  const visibleDelimiter = (node: FormulaSourceAstNode): CompiledPart => {
    const raw = source.slice(node.source_span.start, node.source_span.end);
    const delimiterPairs: Array<[string, string, number, number]> = raw.startsWith("\\{") && raw.endsWith("\\}")
      ? [["{", "}", 2, 2]]
      : raw.length >= 2 && ["()", "[]", "||"].includes(`${raw[0]}${raw.at(-1)}`)
        ? [[raw[0], raw.at(-1)!, 1, 1]]
        : [];
    const children = compileList(node.children ?? []);
    if (!delimiterPairs.length) return children;
    const [left, right, leftLength, rightLength] = delimiterPairs[0];
    const wrapperGroup = nextGroup("delimiter");
    const leftToken: FormulaGlyphToken = {
      alternatives: tokenAlternatives([left]),
      source_span: { start: node.source_span.start, end: node.source_span.start + leftLength },
      groups: [wrapperGroup],
    };
    const rightToken: FormulaGlyphToken = {
      alternatives: tokenAlternatives([right]),
      source_span: { start: node.source_span.end - rightLength, end: node.source_span.end },
      groups: [wrapperGroup],
    };
    return {
      ...children,
      variants: children.variants.map((variant) => [leftToken, ...variant, rightToken]),
      anchor_group: wrapperGroup,
    };
  };

  const structuralCommand = (node: FormulaSourceAstNode, command: string): CompiledPart | null => {
    if (FRACTION_COMMANDS.has(command)) {
      const numerator = compileList(node.arguments?.[0] ?? []);
      const denominator = compileList(node.arguments?.[1] ?? []);
      const numeratorGroup = nextGroup("numerator");
      const denominatorGroup = nextGroup("denominator");
      const anchorGroup = nextGroup("fraction");
      const variants = addGroup(cartesianAppend(
        addGroup(numerator.variants, numeratorGroup),
        addGroup(denominator.variants, denominatorGroup),
      ), anchorGroup);
      return {
        variants,
        constraints: [
          ...numerator.constraints,
          ...denominator.constraints,
          { kind: "above", first_group: numeratorGroup, second_group: denominatorGroup },
        ],
        anchor_group: anchorGroup,
        requires_geometry: true,
        unsupported: [...numerator.unsupported, ...denominator.unsupported],
      };
    }
    if (ROOT_COMMANDS.has(command)) {
      const radicand = compileList(node.arguments?.at(-1) ?? []);
      const rootGroup = nextGroup("root-symbol");
      const radicandGroup = nextGroup("radicand");
      const anchorGroup = nextGroup("root");
      const rootToken: FormulaGlyphToken = {
        alternatives: tokenAlternatives(["√"]),
        source_span: commandSourceSpan(source, node),
        groups: [rootGroup, anchorGroup],
      };
      return {
        variants: radicand.variants.map((variant) => ([
          rootToken,
          ...addGroup([variant], radicandGroup)[0].map((token) => ({
            ...token,
            groups: [...token.groups, anchorGroup],
          })),
        ])),
        constraints: [
          ...radicand.constraints,
          { kind: "right_of", first_group: radicandGroup, second_group: rootGroup },
        ],
        anchor_group: anchorGroup,
        requires_geometry: true,
        unsupported: radicand.unsupported,
      };
    }
    if (VECTOR_ONLY_COMMANDS.has(command)) {
      const content = compileArguments(node);
      content.requires_geometry = true;
      return content;
    }
    if (command === "stackrel" || command === "overset" || command === "underset") {
      const first = compileList(node.arguments?.[0] ?? []);
      const second = compileList(node.arguments?.[1] ?? []);
      const upper = command === "underset" ? second : first;
      const lower = command === "underset" ? first : second;
      const upperGroup = nextGroup("stack-upper");
      const lowerGroup = nextGroup("stack-lower");
      const anchorGroup = nextGroup("stack");
      return {
        variants: addGroup(cartesianAppend(
          addGroup(upper.variants, upperGroup),
          addGroup(lower.variants, lowerGroup),
        ), anchorGroup),
        constraints: [
          ...upper.constraints,
          ...lower.constraints,
          { kind: "above", first_group: upperGroup, second_group: lowerGroup },
        ],
        anchor_group: anchorGroup,
        requires_geometry: true,
        unsupported: [...upper.unsupported, ...lower.unsupported],
      };
    }
    return null;
  };

  const compileCommand = (node: FormulaSourceAstNode): CompiledPart => {
    const command = node.command ?? "";
    if (TRANSPARENT_COMMANDS.has(command)) return compileArguments(node);
    if (LAYOUT_COMMANDS.has(command)) return emptyPart();
    const structural = structuralCommand(node, command);
    if (structural) return structural;
    const commandGroup = nextGroup(`command-${command || "unknown"}`);
    if (command === "ldots" || command === "cdots") {
      const span = commandSourceSpan(source, node);
      const ellipsis: FormulaGlyphToken = {
        alternatives: tokenAlternatives(command === "cdots" ? ["⋯", "…"] : ["…"]),
        source_span: span,
        groups: [commandGroup],
      };
      const dots = [0, 1, 2].map((): FormulaGlyphToken => ({
        alternatives: ["."],
        source_span: span,
        groups: [commandGroup],
      }));
      return {
        variants: [[ellipsis], dots],
        constraints: [],
        anchor_group: commandGroup,
        requires_geometry: false,
        unsupported: [],
      };
    }
    if (NAMED_OPERATORS.has(command)) {
      return {
        variants: [commandNameSpans(source, node, command).map((token) => ({
          ...token,
          groups: [commandGroup],
        }))],
        constraints: [],
        anchor_group: commandGroup,
        requires_geometry: false,
        unsupported: [],
      };
    }
    if (ACCENT_COMMANDS[command]) {
      const content = compileArguments(node);
      const accentGroup = nextGroup("accent-glyph");
      const contentGroup = nextGroup("accent-content");
      const accentAlternatives = tokenAlternatives(ACCENT_COMMANDS[command]);
      const accentToken: FormulaGlyphToken = {
        alternatives: accentAlternatives,
        source_span: commandSourceSpan(source, node),
        groups: [accentGroup, commandGroup],
      };
      const groupedContent = addGroup(addGroup(content.variants, contentGroup), commandGroup);
      return {
        ...content,
        variants: groupedContent.flatMap((variant) => [
          variant.map((token, index) => (index === 0 ? {
            ...token,
            forbidden_adjacent_keys: accentAlternatives,
          } : token)),
          [accentToken, ...variant],
        ]).slice(0, 32),
        constraints: [
          ...content.constraints,
          {
            kind: "above",
            first_group: accentGroup,
            second_group: contentGroup,
            optional_first_group: true,
          },
        ],
        anchor_group: commandGroup,
        requires_geometry: true,
      };
    }
    const alternatives = SYMBOL_COMMANDS[command];
    if (alternatives) {
      return {
        variants: [[{
          alternatives: tokenAlternatives(alternatives),
          source_span: commandSourceSpan(source, node),
          groups: [commandGroup],
        }]],
        constraints: [],
        anchor_group: commandGroup,
        requires_geometry: LARGE_OPERATOR_COMMANDS.has(command),
        unsupported: [],
      };
    }
    return {
      ...emptyPart(),
      unsupported: [`unsupported formula glyph command: ${command || "(missing)"}`],
    };
  };

  const compileNode = (node: FormulaSourceAstNode): CompiledPart => {
    if (node.kind === "character") {
      const group = nextGroup("character");
      const rawAlternatives = node.value === "-" ? ["-", "−"] : [node.value ?? ""];
      const alternatives = tokenAlternatives(rawAlternatives);
      return alternatives.length ? {
        variants: [[{ alternatives, source_span: { ...node.source_span }, groups: [group] }]],
        constraints: [],
        anchor_group: group,
        requires_geometry: false,
        unsupported: [],
      } : emptyPart();
    }
    if (node.kind === "command") return compileCommand(node);
    if (node.kind === "delimiter") return visibleDelimiter(node);
    if (node.kind === "group") return compileList(node.children ?? []);
    if (node.kind === "structural") {
      return { ...emptyPart(), unsupported: [`unsupported formula glyph AST node: ${node.node_kind ?? "unknown"}`] };
    }
    return compileList(node.children ?? []);
  };

  return compileList;
}

export function buildFormulaGlyphPlan(
  source: string,
  span: { start: number; end: number },
): FormulaGlyphPlan {
  const ast = parseFormulaSourceAst(source, span);
  if (ast.status === "invalid") {
    return {
      version: PDF_FORMULA_GLYPH_POLICY.version,
      status: "invalid",
      variants: [],
      constraints: [],
      requires_geometry: false,
      reason: ast.reason ?? "formula source AST is invalid",
    };
  }
  const compiled = buildFormulaCompiler(source)(ast.nodes);
  const variants = compiled.variants
    .filter((tokens) => tokens.length > 0)
    .map((tokens) => ({ tokens }));
  if (compiled.unsupported.length || !variants.length) {
    return {
      version: PDF_FORMULA_GLYPH_POLICY.version,
      status: "unsupported",
      variants: [],
      constraints: compiled.constraints,
      requires_geometry: compiled.requires_geometry,
      reason: compiled.unsupported[0] ?? "formula source AST has no selectable glyph tokens",
    };
  }
  return {
    version: PDF_FORMULA_GLYPH_POLICY.version,
    status: "supported",
    variants,
    constraints: compiled.constraints,
    requires_geometry: compiled.requires_geometry,
  };
}

function groupBox(
  tokens: FormulaGlyphToken[],
  candidates: FormulaGlyphCandidate[],
  group: string,
): [number, number, number, number] | null {
  const boxes = candidates.filter((_candidate, index) => tokens[index].groups.includes(group)).map((item) => item.bbox);
  if (!boxes.length) return null;
  return boxes.reduce<[number, number, number, number]>((union, bbox) => ([
    Math.min(union[0], bbox[0]),
    Math.min(union[1], bbox[1]),
    Math.max(union[2], bbox[2]),
    Math.max(union[3], bbox[3]),
  ]), [...boxes[0]]);
}

function geometryMatches(
  tokens: FormulaGlyphToken[],
  candidates: FormulaGlyphCandidate[],
  constraints: FormulaGlyphConstraint[],
): boolean {
  return constraints.every((constraint) => {
    const first = groupBox(tokens, candidates, constraint.first_group);
    const second = groupBox(tokens, candidates, constraint.second_group);
    if (!first || !second) return Boolean(constraint.optional_first_group && !first && second);
    if (constraint.kind === "right_of") return first[0] >= second[0] - 0.5;
    const firstCenter = (first[1] + first[3]) / 2;
    const secondCenter = (second[1] + second[3]) / 2;
    const tolerance = Math.max(1, Math.min(first[3] - first[1], second[3] - second[1]) * 0.1);
    return firstCenter > secondCenter + tolerance;
  });
}

function uniqueGlyphs(candidates: FormulaGlyphCandidate[]): boolean {
  const ids = candidates.map((candidate) => `${candidate.pageIndex}:${candidate.charIndex}`);
  return new Set(ids).size === ids.length;
}

function hasForbiddenAdjacentGlyph(
  tokens: FormulaGlyphToken[],
  candidates: FormulaGlyphCandidate[],
  start: number,
): boolean {
  const forbidden = new Set(tokens.flatMap((token) => token.forbidden_adjacent_keys ?? []));
  if (!forbidden.size) return false;
  const before = candidates[start - 1]?.key;
  const after = candidates[start + tokens.length]?.key;
  return Boolean((before && forbidden.has(before)) || (after && forbidden.has(after)));
}

export function findFormulaGlyphMatches(
  plan: FormulaGlyphPlan,
  candidates: FormulaGlyphCandidate[],
): FormulaGlyphMatchResult {
  if (plan.status !== "supported") {
    return { matches: [], key_candidate_count: 0, geometry_rejection_count: 0 };
  }
  const matches: FormulaGlyphMatch[] = [];
  let keyCandidateCount = 0;
  let geometryRejectionCount = 0;
  for (let variantIndex = 0; variantIndex < plan.variants.length; variantIndex += 1) {
    const tokens = plan.variants[variantIndex].tokens;
    for (let start = 0; start <= candidates.length - tokens.length; start += 1) {
      const slice = candidates.slice(start, start + tokens.length);
      if (!tokens.every((token, index) => token.alternatives.includes(slice[index].key))) continue;
      keyCandidateCount += 1;
      if (hasForbiddenAdjacentGlyph(tokens, candidates, start)
        || !uniqueGlyphs(slice)
        || !geometryMatches(tokens, slice, plan.constraints)) {
        geometryRejectionCount += 1;
        continue;
      }
      matches.push({
        start,
        end: start + tokens.length,
        source_spans: tokens.map((token) => ({ ...token.source_span })),
        variant_index: variantIndex,
      });
    }
  }
  const unique = new Map(matches.map((match) => ([
    `${match.start}:${match.end}:${match.source_spans.map((span) => `${span.start}-${span.end}`).join(",")}`,
    match,
  ])));
  return {
    matches: [...unique.values()],
    key_candidate_count: keyCandidateCount,
    geometry_rejection_count: geometryRejectionCount,
  };
}
