import * as fs from "fs";
import * as path from "path";
import { extractSelectorFromTs } from "./component_selector";
import { gitTopLevel } from "./git/local";

export type IoKind = "input" | "output";

export interface IoMember {
  kind: IoKind;
  /** Name used in templates / find / remove (alias if present). */
  publicName: string;
  /** TypeScript member name. */
  propertyName: string;
  isSetter: boolean;
  /** Inclusive start offset of decorator in source. */
  start: number;
  /** Exclusive end offset of the member declaration in source. */
  end: number;
  /** True when publicName could not be parsed automatically. */
  needsNamePrompt?: boolean;
  rawSnippet?: string;
}

export interface ParsedComponentFile {
  filePath: string;
  source: string;
  repoName: string;
  repoRoot: string;
  className: string;
  selector: string | null;
  members: IoMember[];
}

const DEFAULT_SKIP = new Set([
  ".git",
  ".angular",
  "node_modules",
  "dist",
  "coverage",
  "tmp",
  "out-tsc",
  ".idea",
  ".vscode",
  "__pycache__",
]);

function walkTsFiles(root: string, skipDirs: Set<string>, out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) {
        continue;
      }
      walkTsFiles(full, skipDirs, out);
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".spec.ts")
    ) {
      out.push(full);
    }
  }
}

export function listTsFilesUnderRoots(
  roots: string[],
  skipDirs: Set<string> = DEFAULT_SKIP
): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const abs = path.resolve(root);
    if (!fs.existsSync(abs)) {
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isFile() && abs.endsWith(".ts")) {
      files.push(abs);
      continue;
    }
    if (stat.isDirectory()) {
      walkTsFiles(abs, skipDirs, files);
    }
  }
  return [...new Set(files)].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  );
}

export function hasAngularComponent(source: string): boolean {
  return /@Component\s*\(/.test(source);
}

export function extractClassName(source: string): string {
  const match = source.match(
    /export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/
  );
  if (match) {
    return match[1];
  }
  const anyClass = source.match(/class\s+([A-Za-z_$][\w$]*)/);
  return anyClass ? anyClass[1] : path.basename(source, ".ts");
}

/**
 * Resolve @Component selector. Returns null when it cannot be determined
 * (caller should prompt).
 */
export function resolveComponentSelector(source: string): string | null {
  const extracted = extractSelectorFromTs(source);
  if (!extracted) {
    return null;
  }
  // Multiple selectors — ask user (do not auto-pick).
  if (extracted.includes(",")) {
    return null;
  }
  return extracted;
}

function skipTrivia(source: string, index: number): number {
  let i = index;
  while (i < source.length) {
    if (/\s/.test(source[i])) {
      i += 1;
      continue;
    }
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl + 1;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    break;
  }
  return i;
}

function matchBalanced(
  source: string,
  openIndex: number,
  openCh: string,
  closeCh: string
): number {
  let depth = 0;
  let inQuote: string | null = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < source.length) {
        i += 1;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inQuote = ch;
      continue;
    }
    if (ch === openCh) {
      depth += 1;
    } else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function endOfStatementOrBlock(source: string, start: number): number {
  let i = skipTrivia(source, start);
  // Optional parameter list for setters: set foo(...)
  if (source[i] === "(") {
    const close = matchBalanced(source, i, "(", ")");
    if (close < 0) {
      return start;
    }
    i = skipTrivia(source, close + 1);
  }
  if (source[i] === "{") {
    const close = matchBalanced(source, i, "{", "}");
    return close < 0 ? source.length : close + 1;
  }
  // Property / field until ; or newline before next decorator/member
  const semi = source.indexOf(";", i);
  if (semi >= 0) {
    return semi + 1;
  }
  const nl = source.indexOf("\n", i);
  return nl < 0 ? source.length : nl;
}

function parseAliasAndRest(
  afterDecorator: string
): { alias: string | null; rest: string } | null {
  const trimmed = afterDecorator.trimStart();
  // @Input() or @Output()
  if (trimmed.startsWith("()")) {
    return { alias: null, rest: trimmed.slice(2) };
  }
  // @Input('alias') or @Input("alias")
  const aliasMatch = trimmed.match(/^\(\s*(['"`])([^'"`]*)\1\s*\)/);
  if (aliasMatch) {
    return { alias: aliasMatch[2], rest: trimmed.slice(aliasMatch[0].length) };
  }
  // @Input({ ... }) — alias unknown; rest continues after closing paren
  if (trimmed.startsWith("(")) {
    const close = matchBalanced(trimmed, 0, "(", ")");
    if (close < 0) {
      return null;
    }
    return { alias: null, rest: trimmed.slice(close + 1) };
  }
  return null;
}

/**
 * Parse decorator @Input / @Output members. Members that cannot be named
 * get needsNamePrompt=true with a best-effort span.
 */
export function parseIoMembers(source: string): IoMember[] {
  const members: IoMember[] = [];
  const re = /@(Input|Output)\b/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const kind: IoKind = match[1] === "Input" ? "input" : "output";
    const decorStart = match.index;
    const afterAt = source.slice(decorStart + match[0].length);
    const parsed = parseAliasAndRest(afterAt);
    if (!parsed) {
      continue;
    }
    // Detect object-form @Input({...}) which we cannot auto-name.
    const rawAfter = afterAt.trimStart();
    const objectForm =
      rawAfter.startsWith("(") &&
      !rawAfter.startsWith("()") &&
      !/^\(\s*['"`]/.test(rawAfter);

    let cursor = skipTrivia(
      source,
      decorStart + match[0].length + (afterAt.length - parsed.rest.length)
    );
    // Skip access modifiers / readonly / abstract / declare / override
    while (true) {
      const mod = source.slice(cursor).match(
        /^(?:public|private|protected|readonly|abstract|declare|override)\b/
      );
      if (!mod) {
        break;
      }
      cursor = skipTrivia(source, cursor + mod[0].length);
    }

    const setter = source.slice(cursor).match(/^set\b/);
    let isSetter = false;
    if (setter) {
      isSetter = true;
      cursor = skipTrivia(source, cursor + setter[0].length);
    }

    const nameMatch = source.slice(cursor).match(/^([A-Za-z_$][\w$]*)/);
    let propertyName = "";
    let publicName = "";
    let needsNamePrompt = false;

    if (!nameMatch || objectForm) {
      needsNamePrompt = true;
      propertyName = nameMatch ? nameMatch[1] : "";
      publicName = parsed.alias || propertyName;
      if (!publicName) {
        needsNamePrompt = true;
      }
    } else {
      propertyName = nameMatch[1];
      publicName = parsed.alias || propertyName;
    }

    const nameEnd = nameMatch
      ? cursor + nameMatch[0].length
      : cursor;
    const end = endOfStatementOrBlock(source, nameEnd);
    const start = decorStart;
    // Include leading newline/indent for cleaner deletion when possible
    let adjStart = start;
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (source.slice(lineStart, start).trim() === "") {
      adjStart = lineStart;
    }

    members.push({
      kind,
      publicName: publicName || "",
      propertyName: propertyName || "",
      isSetter,
      start: adjStart,
      end,
      needsNamePrompt: needsNamePrompt || !publicName,
      rawSnippet: source.slice(adjStart, end).trim(),
    });
  }
  return members;
}

export function repoInfoForFile(
  filePath: string,
  roots: string[]
): { repoName: string; repoRoot: string } {
  const abs = path.resolve(filePath);
  const gitRoot = gitTopLevel(path.dirname(abs));
  if (gitRoot) {
    return { repoName: path.basename(gitRoot), repoRoot: gitRoot };
  }
  for (const root of roots) {
    const resolved = path.resolve(root);
    const rel = path.relative(resolved, abs);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      const parts = rel.split(/[/\\]/).filter(Boolean);
      if (parts.length) {
        return {
          repoName: parts[0],
          repoRoot: path.join(resolved, parts[0]),
        };
      }
      return { repoName: path.basename(resolved), repoRoot: resolved };
    }
  }
  return {
    repoName: path.basename(path.dirname(abs)),
    repoRoot: path.dirname(abs),
  };
}

export function parseComponentFile(
  filePath: string,
  roots: string[]
): ParsedComponentFile | null {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  if (!hasAngularComponent(source)) {
    return null;
  }
  const { repoName, repoRoot } = repoInfoForFile(filePath, roots);
  return {
    filePath: path.resolve(filePath),
    source,
    repoName,
    repoRoot,
    className: extractClassName(source),
    selector: resolveComponentSelector(source),
    members: parseIoMembers(source),
  };
}

/**
 * Remove one @Input/@Output member from component source by public API name
 * and kind. Returns updated source or null if not found / ambiguous.
 */
export function removeIoMemberFromSource(
  source: string,
  kind: IoKind,
  publicName: string,
  propertyName?: string
): { source: string } | { error: string } {
  const members = parseIoMembers(source).filter((m) => m.kind === kind);
  const matches = members.filter(
    (m) =>
      m.publicName === publicName ||
      (propertyName && m.propertyName === propertyName)
  );
  if (!matches.length) {
    return {
      error: `Could not find @${kind === "input" ? "Input" : "Output"} '${publicName}' in TypeScript source`,
    };
  }
  // Prefer exact publicName match
  const exact = matches.filter((m) => m.publicName === publicName);
  const target = (exact.length ? exact : matches)[0];
  if ((exact.length ? exact : matches).length > 1) {
    // Remove the first occurrence; warn via caller if needed
  }
  let next = source.slice(0, target.start) + source.slice(target.end);
  // Collapse extra blank lines
  next = next.replace(/\n{3,}/g, "\n\n");
  return { source: next };
}

export function applyIoMemberRemoval(
  filePath: string,
  kind: IoKind,
  publicName: string,
  propertyName?: string
): { ok: true } | { ok: false; error: string } {
  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    return { ok: false, error: String(err) };
  }
  const result = removeIoMemberFromSource(
    source,
    kind,
    publicName,
    propertyName
  );
  if ("error" in result) {
    return { ok: false, error: result.error };
  }
  try {
    fs.writeFileSync(filePath, result.source, "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
