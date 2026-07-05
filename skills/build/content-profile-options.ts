import {
  PAPER_PROFILE_ID,
  resolveContentProfile,
  type ContentProfileDefinition,
} from "../../packages/core/src/content-profile";

export interface ParsedContentProfileArgs {
  argv: string[];
  contentProfile: ContentProfileDefinition;
}

export interface ParseContentProfileOptions {
  allowPaperExecution?: boolean;
}

export function parseContentProfileArgs(argv: string[], options: ParseContentProfileOptions = {}): ParsedContentProfileArgs {
  const stripped: string[] = [];
  let contentProfileValue: string | undefined;
  let paperSubtypeValue: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== "--content-profile" && arg !== "--paper-subtype") {
      stripped.push(arg);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === "--content-profile") contentProfileValue = value;
    else paperSubtypeValue = value;
    i++;
  }
  const contentProfile = resolveContentProfile(contentProfileValue, { paper_subtype: paperSubtypeValue });
  if (contentProfile.id === PAPER_PROFILE_ID && !options.allowPaperExecution) {
    throw new Error("content_profile paper is resolvable, but this build stage is not implemented for paper yet");
  }
  return {
    argv: stripped,
    contentProfile,
  };
}

export function contentProfileUsage(): string {
  return "[--content-profile technical_learning|paper] [--paper-subtype research_article|survey]";
}

export function parseContentProfileArgsOrExit(
  argv: string[],
  options: ParseContentProfileOptions = {},
): ParsedContentProfileArgs {
  try {
    return parseContentProfileArgs(argv, options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
}

export function parsePaperContentProfileArgsOrExit(argv: string[], stage = "paper build"): ParsedContentProfileArgs {
  const parsed = parseContentProfileArgsOrExit(argv, { allowPaperExecution: true });
  if (parsed.contentProfile.id !== PAPER_PROFILE_ID) {
    console.error(`${stage} requires --content-profile paper`);
    process.exit(2);
  }
  return parsed;
}
