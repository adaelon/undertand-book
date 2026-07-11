const source = process.env.UNDERSTAND_BOOK_MARKETPLACE_SOURCE?.trim();
if (!source) {
  throw new Error("UNDERSTAND_BOOK_MARKETPLACE_SOURCE is required (for example owner/repo)");
}
const publicGit = /^[\w.-]+\/[\w.-]+(?:@[^\s]+)?$/.test(source)
  || /^https:\/\//.test(source)
  || /^git@[^:]+:/.test(source);
if (!publicGit) {
  throw new Error("UNDERSTAND_BOOK_MARKETPLACE_SOURCE must be a public Git marketplace source, not a local path");
}
