#!/usr/bin/env node
/**
 * Find, rename, or remove Angular component input/output bindings in HTML templates.
 *
 * TypeScript/Node port of angular_io_tool.py — same CLI behavior, plus interactive
 * prompts and run logging.
 *
 * Examples:
 *   node dist/angular_io_tool.js find --selector abx-icon --inputs isCustomIcon,isUtilityIcon
 *   node dist/angular_io_tool.js rename --selector abx-icon --rename isCustomIcon=isCustom --apply
 *   node dist/angular_io_tool.js find
 */

import { spawnSync } from "child_process";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BindingMatch {
  propertyName: string;
  matchedName: string;
  kind: string;
  start: number;
  end: number;
  line: number;
  column: number;
  attrText: string;
}

interface UsageHit {
  filePath: string;
  repo: string;
  selector: string;
  tagStart: number;
  tagEnd: number;
  tagLine: number;
  tagColumn: number;
  snippet: string;
  bindings: BindingMatch[];
}

interface ChangeDetail {
  line: number;
  column: number;
  message: string;
}

interface FileChangePlan {
  filePath: string;
  repo: string;
  original: string;
  updated: string;
  changeCount: number;
  details: ChangeDetail[];
}

interface CommandOptions {
  command: "find" | "report" | "rename" | "remove";
  selector: string;
  inputs: string[];
  outputs: string[];
  roots: string[];
  rename?: string[];
  apply?: boolean;
  format?: "markdown" | "json";
  output?: string;
  interactive?: boolean;
  log?: string;
  noLog?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set([
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

const PROJECT_DIR_NAMES = new Set([
  "src",
  "projects",
  "apps",
  "libs",
  "public",
  "web",
  "client",
]);

const TOOL_ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_LOG_DIR = path.join(TOOL_ROOT, "logs");

// ---------------------------------------------------------------------------
// Logging / console tee
// ---------------------------------------------------------------------------

const logChunks: string[] = [];
let loggingEnabled = true;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function appendLog(chunk: string): void {
  if (loggingEnabled) {
    logChunks.push(stripAnsi(chunk));
  }
}

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function installConsoleTee(): void {
  (process.stdout as NodeJS.WriteStream).write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encoding === "string" ? encoding : "utf8"
          );
    appendLog(text);
    if (typeof encoding === "function") {
      return originalStdoutWrite(chunk, encoding);
    }
    return originalStdoutWrite(chunk, encoding as BufferEncoding, cb);
  }) as typeof process.stdout.write;

  (process.stderr as NodeJS.WriteStream).write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void
  ): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.from(chunk).toString(
            typeof encoding === "string" ? encoding : "utf8"
          );
    appendLog(text);
    if (typeof encoding === "function") {
      return originalStderrWrite(chunk, encoding);
    }
    return originalStderrWrite(chunk, encoding as BufferEncoding, cb);
  }) as typeof process.stderr.write;
}

function writeRunLog(
  opts: CommandOptions,
  roots: string[],
  extraSummary: string[],
  logPath: string | null
): void {
  if (!logPath) {
    return;
  }
  const dir = path.dirname(logPath);
  fs.mkdirSync(dir, { recursive: true });
  const header = [
    `=== ${new Date().toISOString()} | ${opts.command} ===`,
    `selector: ${opts.selector}`,
    `inputs: ${opts.inputs.length ? opts.inputs.join(", ") : "(none)"}`,
    `outputs: ${opts.outputs.length ? opts.outputs.join(", ") : "(none)"}`,
    opts.rename?.length
      ? `rename: ${opts.rename.join(", ")}`
      : undefined,
    `apply: ${opts.apply ? "true" : "false"}`,
    `roots: ${roots.join("; ")}`,
    ...extraSummary,
    "--- console output ---",
    "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  fs.writeFileSync(logPath, header + logChunks.join(""), "utf8");
  // Print after restoring would still tee — use original write for this notice
  originalStdoutWrite(`\nRun log written to ${logPath}\n`);
}

function defaultLogPath(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  return path.join(DEFAULT_LOG_DIR, `run-${stamp}.log`);
}

function resolveLogPath(opts: CommandOptions): string | null {
  if (opts.noLog) {
    return null;
  }
  if (opts.log) {
    return path.resolve(opts.log);
  }
  return defaultLogPath();
}

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------

function useColor(): boolean {
  return !process.env.NO_COLOR && Boolean(process.stdout.isTTY);
}

function paint(text: string, code: string): string {
  if (!useColor()) {
    return text;
  }
  return `\u001b[${code}m${text}\u001b[0m`;
}

function bold(text: string): string {
  return paint(text, "1");
}
function dim(text: string): string {
  return paint(text, "2");
}
function green(text: string): string {
  return paint(text, "32");
}
function yellow(text: string): string {
  return paint(text, "33");
}
function cyan(text: string): string {
  return paint(text, "36");
}
function red(text: string): string {
  return paint(text, "31");
}

function fail(message: string): never {
  console.error(red(message));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Name / CLI parsing helpers
// ---------------------------------------------------------------------------

function camelToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function nameVariants(name: string): string[] {
  const raw = name.trim();
  if (!raw) {
    return [];
  }
  const kebab = camelToKebab(raw);
  const variants = [raw];
  if (kebab !== raw) {
    variants.push(kebab);
  }
  if (raw.includes("-")) {
    const parts = raw.split("-");
    const camel =
      parts[0] +
      parts
        .slice(1)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
    if (camel && !variants.includes(camel)) {
      variants.push(camel);
    }
  }
  return variants;
}

function parseNameList(values: string[] | undefined | null): string[] {
  if (!values || values.length === 0) {
    return [];
  }
  const names: string[] = [];
  for (const value of values) {
    let text = value.trim();
    if (text.startsWith("[") && text.endsWith("]")) {
      text = text.slice(1, -1);
    }
    for (const part of text.split(/[,\s]+/)) {
      const cleaned = part.trim().replace(/^\[|\]$/g, "");
      if (cleaned) {
        names.push(cleaned);
      }
    }
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of names) {
    if (!seen.has(name)) {
      seen.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

function parseRenameMap(values: string[] | undefined | null): Record<string, string> {
  if (!values || values.length === 0) {
    return {};
  }
  const mapping: Record<string, string> = {};
  for (const value of values) {
    let text = value.trim();
    if (text.startsWith("[") && text.endsWith("]")) {
      text = text.slice(1, -1);
    }
    for (const part of text.split(/[,\s]+/)) {
      const cleaned = part.trim().replace(/^\[|\]$/g, "");
      if (!cleaned) {
        continue;
      }
      if (!cleaned.includes("=")) {
        fail(`Invalid --rename entry '${cleaned}'; expected old=new`);
      }
      const eq = cleaned.indexOf("=");
      const oldName = cleaned.slice(0, eq).trim();
      const newName = cleaned.slice(eq + 1).trim();
      if (!oldName || !newName) {
        fail(`Invalid --rename entry '${cleaned}'; expected old=new`);
      }
      mapping[oldName] = newName;
    }
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// Filesystem / ripgrep
// ---------------------------------------------------------------------------

function which(cmd: string): string | null {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [cmd], {
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0) {
    return null;
  }
  const first = (result.stdout || "").split(/\r?\n/).map((l) => l.trim()).find(Boolean);
  return first || null;
}

function requireRg(): string {
  const found = which("rg");
  if (!found) {
    fail("ripgrep (rg) was not found on PATH. Install it, then re-run this tool.");
  }
  return found;
}

function normalizeRoots(roots: string[] | undefined | null): string[] {
  if (!roots || roots.length === 0) {
    return [path.resolve(process.cwd())];
  }
  const resolved: string[] = [];
  for (const raw of roots) {
    for (const piece of raw.split(";")) {
      const trimmed = piece.trim().replace(/^"|"$/g, "");
      if (!trimmed) {
        continue;
      }
      const expanded = trimmed.startsWith("~")
        ? path.join(os.homedir(), trimmed.slice(1))
        : trimmed;
      const abs = path.resolve(expanded);
      if (!fs.existsSync(abs)) {
        fail(`Root path does not exist: ${abs}`);
      }
      if (!fs.statSync(abs).isDirectory()) {
        fail(`Root path is not a directory: ${abs}`);
      }
      resolved.push(abs);
    }
  }
  if (resolved.length === 0) {
    return [path.resolve(process.cwd())];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of resolved) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

function gitTopLevel(dir: string): string | null {
  try {
    const result = spawnSync(
      "git",
      ["-C", dir, "rev-parse", "--show-toplevel"],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      return null;
    }
    const top = (result.stdout || "").trim();
    return top ? path.resolve(top) : null;
  } catch {
    return null;
  }
}

function pathRelative(from: string, to: string): string | null {
  const rel = path.relative(from, to);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    // On Windows, different drives → absolute relative
    if (path.isAbsolute(rel)) {
      return null;
    }
    if (rel.startsWith("..")) {
      return null;
    }
  }
  return rel;
}

function repoLabelFor(filePath: string, roots: string[]): string {
  const resolved = path.resolve(filePath);
  const gitRoot = gitTopLevel(path.dirname(resolved));

  for (const root of roots) {
    const relative = pathRelative(root, resolved);
    if (relative === null) {
      continue;
    }
    if (gitRoot) {
      const gitRel = pathRelative(root, gitRoot);
      if (gitRel !== null) {
        return gitRoot === root ? path.basename(root) : path.basename(gitRoot);
      }
    }
    const parts = relative.split(/[/\\]/).filter(Boolean);
    if (parts.length === 0) {
      return path.basename(root);
    }
    if (PROJECT_DIR_NAMES.has(parts[0].toLowerCase())) {
      return path.basename(root);
    }
    return parts[0];
  }

  if (gitRoot) {
    return path.basename(gitRoot);
  }
  return path.basename(path.dirname(resolved)) || path.dirname(resolved);
}

function rgFindSelectorHits(
  selector: string,
  roots: string[]
): Array<{ filePath: string; line: number }> {
  const rg = requireRg();
  const pattern = `<${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`;
  const cmd: string[] = [
    "--glob",
    "*.html",
    "--line-number",
    "--with-filename",
    "--no-heading",
    "--color",
    "never",
    "--hidden",
  ];
  for (const name of [...SKIP_DIR_NAMES].sort()) {
    cmd.push("--glob", `!${name}/**`);
  }
  cmd.push(pattern, ...roots);

  const result = spawnSync(rg, cmd, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    fail(`failed to run ripgrep: ${result.error.message}`);
  }
  const code = result.status ?? 2;
  if (code !== 0 && code !== 1) {
    const err =
      (result.stderr || result.stdout || "").trim() || `rg exited ${code}`;
    fail(`ripgrep failed: ${err}`);
  }

  const hits: Array<{ filePath: string; line: number }> = [];
  for (const line of (result.stdout || "").split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    const match = /^(.*):(\d+):(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    hits.push({
      filePath: path.resolve(match[1]),
      line: Number(match[2]),
    });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// HTML opening-tag extraction and binding parsing
// ---------------------------------------------------------------------------

function findOpeningTagSpan(
  text: string,
  startIndex: number,
  selector: string
): [number, number] | null {
  const pattern = new RegExp(
    `<${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i"
  );
  pattern.lastIndex = 0;
  const slice = text.slice(startIndex);
  const match = pattern.exec(slice);
  if (!match || match.index === undefined) {
    return null;
  }
  const i = startIndex + match.index;
  const n = text.length;
  let inQuote: string | null = null;
  let j = i + match[0].length;
  while (j < n) {
    const ch = text[j];
    if (inQuote) {
      if (ch === inQuote) {
        inQuote = null;
      } else if (ch === "\\" && j + 1 < n) {
        j += 1;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ">") {
      return [i, j + 1];
    }
    j += 1;
  }
  return null;
}

function lineColAt(text: string, index: number): [number, number] {
  const before = text.slice(0, index);
  const line = (before.match(/\n/g) || []).length + 1;
  const lastNl = before.lastIndexOf("\n");
  const col = index - lastNl;
  return [line, col];
}

function snippetForSpan(
  text: string,
  start: number,
  end: number,
  maxLines = 6
): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", Math.max(0, end - 1));
  if (lineEnd < 0) {
    lineEnd = text.length;
  }
  const block = text.slice(lineStart, lineEnd).replace(/\s+$/u, "");
  const lines = block.split(/\r?\n/);
  if (lines.length > maxLines) {
    return lines.slice(0, maxLines - 1).join("\n") + "\n  ...";
  }
  return block;
}

function attrPatterns(name: string): Array<[string, RegExp]> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = String.raw`(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?`;
  return [
    ["two-way", new RegExp(String.raw`\[\(${esc}\)\]${value}`, "g")],
    ["property", new RegExp(String.raw`\[${esc}\]${value}`, "g")],
    ["output", new RegExp(String.raw`\(${esc}\)${value}`, "g")],
    [
      "attribute",
      new RegExp(String.raw`(?<![\w\-\[\(\)\]])\b${esc}\b${value}`, "g"),
    ],
  ];
}

function findBindingsInTag(
  tagText: string,
  tagStart: number,
  fileText: string,
  propertyNames: string[],
  kinds: string[]
): BindingMatch[] {
  const allowed = new Set(kinds);
  const variantToCanonical = new Map<string, string>();
  for (const canonical of propertyNames) {
    for (const variant of nameVariants(canonical)) {
      if (!variantToCanonical.has(variant)) {
        variantToCanonical.set(variant, canonical);
      }
    }
  }

  const matches: BindingMatch[] = [];
  const occupied: Array<[number, number]> = [];
  const overlaps = (a: number, b: number): boolean =>
    occupied.some(([s, e]) => !(b <= s || a >= e));

  const variantsSorted = [...variantToCanonical.keys()].sort(
    (a, b) => b.length - a.length
  );

  for (const variant of variantsSorted) {
    const canonical = variantToCanonical.get(variant)!;
    for (const [kind, pattern] of attrPatterns(variant)) {
      if (!allowed.has(kind)) {
        continue;
      }
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(tagText)) !== null) {
        const localStart = match.index;
        const localEnd = match.index + match[0].length;
        if (overlaps(localStart, localEnd)) {
          continue;
        }
        const absStart = tagStart + localStart;
        const absEnd = tagStart + localEnd;
        const [line, col] = lineColAt(fileText, absStart);
        matches.push({
          propertyName: canonical,
          matchedName: variant,
          kind,
          start: absStart,
          end: absEnd,
          line,
          column: col,
          attrText: match[0],
        });
        occupied.push([localStart, localEnd]);
      }
    }
  }

  matches.sort(
    (a, b) => a.start - b.start || a.propertyName.localeCompare(b.propertyName)
  );
  return matches;
}

function collectUsages(
  selector: string,
  roots: string[],
  inputNames: string[],
  outputNames: string[]
): UsageHit[] {
  const filterBindings = inputNames.length > 0 || outputNames.length > 0;
  const wantedInputs = [...inputNames];
  const wantedOutputs = [...outputNames];

  const rgHits = rgFindSelectorHits(selector, roots);
  const byFile = new Map<string, number[]>();
  for (const hit of rgHits) {
    const list = byFile.get(hit.filePath) || [];
    list.push(hit.line);
    byFile.set(hit.filePath, list);
  }

  const usages: UsageHit[] = [];
  const filesSorted = [...byFile.entries()].sort((a, b) =>
    a[0].toLowerCase().localeCompare(b[0].toLowerCase())
  );

  for (const [filePath, lineNos] of filesSorted) {
    let text: string;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      console.error(red(`Warning: could not read ${filePath}: ${err}`));
      continue;
    }

    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === "\n") {
        lineStarts.push(i + 1);
      }
    }

    const seenSpans = new Set<string>();
    const repo = repoLabelFor(filePath, roots);

    for (const lineNo of [...new Set(lineNos)].sort((a, b) => a - b)) {
      if (lineNo < 1 || lineNo > lineStarts.length) {
        continue;
      }
      const approx = lineStarts[lineNo - 1];
      let span = findOpeningTagSpan(text, approx, selector);
      if (!span) {
        span = findOpeningTagSpan(text, Math.max(0, approx - 200), selector);
      }
      if (!span) {
        continue;
      }
      const key = `${span[0]}:${span[1]}`;
      if (seenSpans.has(key)) {
        continue;
      }
      seenSpans.add(key);
      const [tagStart, tagEnd] = span;
      const tagText = text.slice(tagStart, tagEnd);
      const [tagLine, tagCol] = lineColAt(text, tagStart);

      let bindings: BindingMatch[] = [];
      if (wantedInputs.length) {
        bindings = bindings.concat(
          findBindingsInTag(tagText, tagStart, text, wantedInputs, [
            "property",
            "attribute",
            "two-way",
          ])
        );
      }
      if (wantedOutputs.length) {
        bindings = bindings.concat(
          findBindingsInTag(tagText, tagStart, text, wantedOutputs, [
            "output",
            "two-way",
          ])
        );
      }
      const uniq = new Map<string, BindingMatch>();
      for (const binding of bindings) {
        uniq.set(`${binding.start}:${binding.end}:${binding.kind}`, binding);
      }
      bindings = [...uniq.values()].sort((a, b) => a.start - b.start);

      if (filterBindings && bindings.length === 0) {
        continue;
      }

      usages.push({
        filePath,
        repo,
        selector,
        tagStart,
        tagEnd,
        tagLine,
        tagColumn: tagCol,
        snippet: snippetForSpan(text, tagStart, tagEnd),
        bindings,
      });
    }
  }
  return usages;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function replaceNameInAttr(
  attrText: string,
  oldNames: string[],
  newName: string
): string {
  const unique = [...new Set(oldNames)].sort((a, b) => b.length - a.length);
  for (const old of unique) {
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let updated = attrText.replace(
      new RegExp(String.raw`\[\(${esc}\)\]`),
      `[(${newName})]`
    );
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\[${esc}\]`), `[${newName}]`);
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\(${esc}\)`), `(${newName})`);
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\b${esc}\b`), newName);
    if (updated !== attrText) {
      return updated;
    }
  }
  return attrText;
}

function collapseAttrWhitespace(
  text: string,
  removedStart: number,
  removedEnd: number
): [string, number, number] {
  let start = removedStart;
  let end = removedEnd;
  if (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) {
    start -= 1;
  } else if (end < text.length && (text[end] === " " || text[end] === "\t")) {
    end += 1;
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) {
    lineEnd = text.length;
  }
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (before.trim() === "" && after.trim() === "") {
    if (lineEnd < text.length && text[lineEnd] === "\n") {
      return [
        text.slice(0, lineStart) + text.slice(lineEnd + 1),
        lineStart,
        lineEnd + 1,
      ];
    }
    if (lineStart > 0 && text[lineStart - 1] === "\n") {
      return [
        text.slice(0, lineStart - 1) + text.slice(lineEnd),
        lineStart - 1,
        lineEnd,
      ];
    }
  }
  return [text.slice(0, start) + text.slice(end), start, end];
}

function planRenames(
  usages: UsageHit[],
  renameMap: Record<string, string>
): FileChangePlan[] {
  const byFile = new Map<string, UsageHit[]>();
  for (const usage of usages) {
    const list = byFile.get(usage.filePath) || [];
    list.push(usage);
    byFile.set(usage.filePath, list);
  }

  const plans: FileChangePlan[] = [];
  const filesSorted = [...byFile.entries()].sort((a, b) =>
    a[0].toLowerCase().localeCompare(b[0].toLowerCase())
  );

  for (const [filePath, fileUsages] of filesSorted) {
    const original = fs.readFileSync(filePath, "utf8");
    const edits: Array<{
      start: number;
      end: number;
      repl: string;
      detail: ChangeDetail;
    }> = [];

    for (const usage of fileUsages) {
      for (const binding of usage.bindings) {
        const newCanonical = renameMap[binding.propertyName];
        if (!newCanonical) {
          continue;
        }
        let newTemplateName = newCanonical;
        if (
          binding.matchedName.includes("-") &&
          !newCanonical.includes("-")
        ) {
          newTemplateName = camelToKebab(newCanonical);
        }
        const newAttr = replaceNameInAttr(
          binding.attrText,
          [...nameVariants(binding.propertyName), binding.matchedName],
          newTemplateName
        );
        if (newAttr === binding.attrText) {
          continue;
        }
        edits.push({
          start: binding.start,
          end: binding.end,
          repl: newAttr,
          detail: {
            line: binding.line,
            column: binding.column,
            message: `${binding.kind} ${binding.matchedName} → ${newTemplateName}`,
          },
        });
      }
    }

    if (edits.length === 0) {
      continue;
    }
    const uniq = new Map<string, (typeof edits)[0]>();
    for (const edit of edits) {
      uniq.set(`${edit.start}:${edit.end}`, edit);
    }
    const ordered = [...uniq.values()].sort((a, b) => b.start - a.start);
    let updated = original;
    const details: ChangeDetail[] = [];
    for (const edit of ordered) {
      updated = updated.slice(0, edit.start) + edit.repl + updated.slice(edit.end);
      details.push(edit.detail);
    }
    details.reverse();
    plans.push({
      filePath,
      repo: fileUsages[0].repo,
      original,
      updated,
      changeCount: details.length,
      details,
    });
  }
  return plans;
}

function planRemovals(
  usages: UsageHit[],
  inputNames: string[],
  outputNames: string[]
): FileChangePlan[] {
  const wanted = new Set([...inputNames, ...outputNames]);
  const byFile = new Map<string, UsageHit[]>();
  for (const usage of usages) {
    const list = byFile.get(usage.filePath) || [];
    list.push(usage);
    byFile.set(usage.filePath, list);
  }

  const plans: FileChangePlan[] = [];
  const filesSorted = [...byFile.entries()].sort((a, b) =>
    a[0].toLowerCase().localeCompare(b[0].toLowerCase())
  );

  for (const [filePath, fileUsages] of filesSorted) {
    const original = fs.readFileSync(filePath, "utf8");
    const removals: Array<{
      start: number;
      end: number;
      detail: ChangeDetail;
    }> = [];

    for (const usage of fileUsages) {
      for (const binding of usage.bindings) {
        if (!wanted.has(binding.propertyName)) {
          continue;
        }
        removals.push({
          start: binding.start,
          end: binding.end,
          detail: {
            line: binding.line,
            column: binding.column,
            message: `remove ${binding.kind} ${binding.matchedName}`,
          },
        });
      }
    }
    if (removals.length === 0) {
      continue;
    }
    const uniq = new Map<string, (typeof removals)[0]>();
    for (const rem of removals) {
      uniq.set(`${rem.start}:${rem.end}`, rem);
    }
    const ordered = [...uniq.values()].sort((a, b) => b.start - a.start);
    let updated = original;
    const details: ChangeDetail[] = [];
    for (const rem of ordered) {
      const collapsed = collapseAttrWhitespace(updated, rem.start, rem.end);
      updated = collapsed[0];
      details.push(rem.detail);
    }
    details.reverse();
    if (updated === original) {
      continue;
    }
    plans.push({
      filePath,
      repo: fileUsages[0].repo,
      original,
      updated,
      changeCount: details.length,
      details,
    });
  }
  return plans;
}

function formatClickablePath(
  filePath: string,
  line: number,
  column = 1
): string {
  return `${path.resolve(filePath)}:${line}:${column}`;
}

function applyPlans(
  plans: FileChangePlan[],
  apply: boolean
): { repos: string[]; files: string[] } {
  if (plans.length === 0) {
    console.log(yellow("No matching bindings found — nothing to change."));
    return { repos: [], files: [] };
  }
  if (!apply) {
    console.log(
      yellow("DRY RUN — no files modified.") +
        " Pass " +
        bold("--apply") +
        " to write changes locally.\n"
    );
  } else {
    console.log(green("Applying local edits…\n"));
  }

  const byRepo = new Map<string, FileChangePlan[]>();
  for (const plan of plans) {
    const list = byRepo.get(plan.repo) || [];
    list.push(plan);
    byRepo.set(plan.repo, list);
  }

  console.log(bold(`Repositories affected (${byRepo.size}):`));
  for (const repo of [...byRepo.keys()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  )) {
    const repoPlans = byRepo.get(repo)!;
    const files = repoPlans.length;
    const changes = repoPlans.reduce((sum, p) => sum + p.changeCount, 0);
    const label = cyan(repo);
    const pad = " ".repeat(Math.max(1, 40 - repo.length));
    console.log(`  ${label}${pad} ${files} file(s), ${changes} change(s)`);
  }

  console.log();
  console.log(bold(`Files (${plans.length}):`));
  for (const plan of plans) {
    const marker = apply ? green("updated") : dim("would update");
    console.log(`  [${marker}] ${plan.filePath}  (${plan.changeCount})`);
    for (const detail of plan.details) {
      const link = formatClickablePath(plan.filePath, detail.line, detail.column);
      console.log(`      - ${link}  ${dim(detail.message)}`);
    }
  }

  if (apply) {
    for (const plan of plans) {
      fs.writeFileSync(plan.filePath, plan.updated, "utf8");
    }
    console.log();
    console.log(
      green(`Wrote ${plans.length} file(s).`) +
        " Review the diffs in GitHub Desktop (or git diff), then commit manually."
    );
  } else {
    console.log();
    console.log(
      "Review the list above. When ready, re-run the same command with " +
        bold("--apply") +
        "."
    );
  }

  return {
    repos: [...byRepo.keys()].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    ),
    files: plans.map((p) => p.filePath),
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printFindReport(
  usages: UsageHit[],
  selector: string,
  inputNames: string[],
  outputNames: string[]
): { repos: string[]; files: string[] } {
  const inputsLabel = inputNames.length ? inputNames.join(", ") : "(none)";
  const outputsLabel = outputNames.length ? outputNames.join(", ") : "(none)";
  const bindingCount = usages.reduce((sum, u) => sum + u.bindings.length, 0);
  const files = new Set(usages.map((u) => u.filePath));
  const repos = new Set(usages.map((u) => u.repo));

  console.log(bold(`Component selector: <${selector}>`));
  console.log(`Inputs:  ${inputsLabel}`);
  console.log(`Outputs: ${outputsLabel}`);
  console.log();

  if (usages.length === 0) {
    console.log(yellow("No matching usages found."));
    return { repos: [], files: [] };
  }

  if (inputNames.length || outputNames.length) {
    console.log(
      bold(
        `Found ${bindingCount} binding(s) across ${usages.length} tag(s) ` +
          `in ${files.size} file(s) / ${repos.size} repo(s)`
      )
    );
  } else {
    console.log(
      bold(
        `Found ${usages.length} <${selector}> usage(s) ` +
          `in ${files.size} file(s) / ${repos.size} repo(s)`
      )
    );
  }
  console.log();

  let index = 1;
  for (const usage of usages) {
    if (usage.bindings.length) {
      for (const binding of usage.bindings) {
        const kindLabel: Record<string, string> = {
          property: "property binding",
          attribute: "attribute binding",
          "two-way": "two-way binding",
          output: "output binding",
        };
        console.log(
          `[${index}] ${bold(binding.propertyName)}  ` +
            dim(`(${kindLabel[binding.kind] || binding.kind})`)
        );
        console.log(
          `    ${formatClickablePath(usage.filePath, binding.line, binding.column)}`
        );
        console.log(`    repo: ${cyan(usage.repo)}`);
        for (const line of usage.snippet.split(/\r?\n/)) {
          console.log(dim(`    ${line}`));
        }
        console.log();
        index += 1;
      }
    } else {
      console.log(
        `[${index}] ${bold("<" + selector + ">")}  ` + dim("(selector usage)")
      );
      console.log(
        `    ${formatClickablePath(usage.filePath, usage.tagLine, usage.tagColumn)}`
      );
      console.log(`    repo: ${cyan(usage.repo)}`);
      for (const line of usage.snippet.split(/\r?\n/)) {
        console.log(dim(`    ${line}`));
      }
      console.log();
      index += 1;
    }
  }

  console.log(bold("Summary"));
  console.log(`  Repositories: ${repos.size}`);
  for (const repo of [...repos].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  )) {
    const count = usages.filter((u) => u.repo === repo).length;
    console.log(`    - ${repo}: ${count} tag(s)`);
  }
  console.log(`  Files:        ${files.size}`);
  console.log(`  Tags:         ${usages.length}`);
  if (inputNames.length || outputNames.length) {
    console.log(`  Bindings:     ${bindingCount}`);
  }

  return {
    repos: [...repos].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
    files: [...files].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())),
  };
}

function usagesToMarkdown(
  usages: UsageHit[],
  selector: string,
  inputNames: string[],
  outputNames: string[]
): string {
  const lines: string[] = [
    `# Angular IO usage report: \`<${selector}>\``,
    "",
    `- Inputs: ${inputNames.length ? inputNames.join(", ") : "(none)"}`,
    `- Outputs: ${outputNames.length ? outputNames.join(", ") : "(none)"}`,
    `- Tags: ${usages.length}`,
    `- Files: ${new Set(usages.map((u) => u.filePath)).size}`,
    `- Repositories: ${new Set(usages.map((u) => u.repo)).size}`,
    "",
  ];
  usages.forEach((usage, i) => {
    lines.push(`## ${i + 1}. \`${usage.repo}\` — \`${usage.filePath}\``);
    lines.push("");
    lines.push(`- Tag at line ${usage.tagLine}`);
    if (usage.bindings.length) {
      lines.push("- Bindings:");
      for (const binding of usage.bindings) {
        lines.push(
          `  - \`${binding.propertyName}\` (${binding.kind}) ` +
            `at ${usage.filePath}:${binding.line}:${binding.column}`
        );
      }
    }
    lines.push("");
    lines.push("```html");
    lines.push(usage.snippet);
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}

function usagesToJson(
  usages: UsageHit[],
  selector: string,
  inputNames: string[],
  outputNames: string[]
): string {
  return JSON.stringify(
    {
      selector,
      inputs: inputNames,
      outputs: outputNames,
      usages: usages.map((u) => ({
        repo: u.repo,
        file: u.filePath,
        tagLine: u.tagLine,
        tagColumn: u.tagColumn,
        snippet: u.snippet,
        bindings: u.bindings.map((b) => ({
          property: b.propertyName,
          matchedName: b.matchedName,
          kind: b.kind,
          line: b.line,
          column: b.column,
          text: b.attrText,
        })),
      })),
    },
    null,
    2
  );
}

// ---------------------------------------------------------------------------
// Interactive prompts
// ---------------------------------------------------------------------------

function createRl(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

async function promptText(
  rl: readline.Interface,
  label: string,
  opts: { defaultValue?: string; required?: boolean } = {}
): Promise<string> {
  const { defaultValue, required } = opts;
  const suffix =
    defaultValue !== undefined && defaultValue !== ""
      ? ` [${defaultValue}]`
      : required
        ? ""
        : " (optional)";
  while (true) {
    const raw = await ask(rl, `${label}${suffix}: `);
    const value = raw.trim();
    if (value.toLowerCase() === "q") {
      console.log("Cancelled.");
      process.exit(130);
    }
    if (value) {
      return value;
    }
    if (defaultValue !== undefined) {
      return defaultValue;
    }
    if (!required) {
      return "";
    }
    console.log(yellow("This value is required. Enter a value, or q to quit."));
  }
}

async function promptYesNo(
  rl: readline.Interface,
  label: string,
  defaultYes: boolean
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  while (true) {
    const raw = (await ask(rl, `${label} [${hint}]: `)).trim().toLowerCase();
    if (!raw) {
      return defaultYes;
    }
    if (raw === "y" || raw === "yes") {
      return true;
    }
    if (raw === "n" || raw === "no") {
      return false;
    }
    if (raw === "q") {
      console.log("Cancelled.");
      process.exit(130);
    }
    console.log(yellow("Please answer y or n."));
  }
}

async function promptRoots(rl: readline.Interface, existing: string[]): Promise<string[]> {
  if (existing.length) {
    return existing;
  }
  const raw = await promptText(
    rl,
    "Roots (paths separated by ; — Enter = current directory)",
    { defaultValue: process.cwd() }
  );
  if (!raw || raw === process.cwd()) {
    return [];
  }
  return raw.split(/[;]+/).map((s) => s.trim()).filter(Boolean);
}

async function confirmOptions(
  rl: readline.Interface,
  opts: CommandOptions
): Promise<boolean> {
  console.log();
  console.log(bold("About to run:"));
  console.log(`  command:  ${opts.command}`);
  console.log(`  selector: ${opts.selector}`);
  if (opts.command === "rename") {
    console.log(`  rename:   ${(opts.rename || []).join(", ")}`);
  } else {
    console.log(
      `  inputs:   ${opts.inputs.length ? opts.inputs.join(", ") : "(none)"}`
    );
    console.log(
      `  outputs:  ${opts.outputs.length ? opts.outputs.join(", ") : "(none)"}`
    );
  }
  if (opts.command === "report") {
    console.log(`  format:   ${opts.format || "markdown"}`);
    console.log(`  output:   ${opts.output || "(stdout)"}`);
  }
  if (opts.command === "rename" || opts.command === "remove") {
    console.log(`  apply:    ${opts.apply ? "yes" : "no (dry-run)"}`);
  }
  console.log(
    `  roots:    ${opts.roots.length ? opts.roots.join("; ") : "(cwd)"}`
  );
  console.log();
  return promptYesNo(rl, "Proceed?", true);
}

async function interactiveFind(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive find\n"));
  const selector =
    partial.selector ||
    (await promptText(rl, "Component selector (e.g. abx-icon)", {
      required: true,
    }));
  const inputsRaw =
    partial.inputs?.length
      ? partial.inputs.join(",")
      : await promptText(rl, "Inputs (comma-separated)", {});
  const outputsRaw =
    partial.outputs?.length
      ? partial.outputs.join(",")
      : await promptText(rl, "Outputs (comma-separated)", {});
  const roots = await promptRoots(rl, partial.roots || []);
  const opts: CommandOptions = {
    command: "find",
    selector,
    inputs: parseNameList(inputsRaw ? [inputsRaw] : []),
    outputs: parseNameList(outputsRaw ? [outputsRaw] : []),
    roots,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
  };
  if (!(await confirmOptions(rl, opts))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function interactiveReport(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive report\n"));
  const selector =
    partial.selector ||
    (await promptText(rl, "Component selector (e.g. abx-icon)", {
      required: true,
    }));
  const inputsRaw =
    partial.inputs?.length
      ? partial.inputs.join(",")
      : await promptText(rl, "Inputs (comma-separated)", {});
  const outputsRaw =
    partial.outputs?.length
      ? partial.outputs.join(",")
      : await promptText(rl, "Outputs (comma-separated)", {});
  let format = partial.format;
  if (!format) {
    const fmtRaw = await promptText(rl, "Format (markdown/json)", {
      defaultValue: "markdown",
    });
    format = fmtRaw === "json" || fmtRaw === "2" ? "json" : "markdown";
  }
  const output =
    partial.output ||
    (await promptText(rl, "Output file path (Enter = stdout)", {}));
  const roots = await promptRoots(rl, partial.roots || []);
  const opts: CommandOptions = {
    command: "report",
    selector,
    inputs: parseNameList(inputsRaw ? [inputsRaw] : []),
    outputs: parseNameList(outputsRaw ? [outputsRaw] : []),
    roots,
    format,
    output: output || undefined,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
  };
  if (!(await confirmOptions(rl, opts))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function interactiveRename(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive rename\n"));
  const selector =
    partial.selector ||
    (await promptText(rl, "Component selector (e.g. abx-icon)", {
      required: true,
    }));
  let rename = partial.rename || [];
  if (!rename.length) {
    const pairs: string[] = [];
    console.log(
      dim("Enter rename pairs as old=new. Press Enter on an empty line when done.")
    );
    while (true) {
      const raw = await promptText(
        rl,
        pairs.length ? "Another rename (old=new)" : "Rename (old=new)",
        { required: pairs.length === 0 }
      );
      if (!raw) {
        break;
      }
      pairs.push(raw);
      if (raw.includes(",")) {
        break;
      }
    }
    rename = pairs;
  }
  const roots = await promptRoots(rl, partial.roots || []);
  let apply = partial.apply || false;
  if (!partial.apply) {
    apply = await promptYesNo(
      rl,
      "Apply changes to files now? (No = dry-run)",
      false
    );
  }
  const opts: CommandOptions = {
    command: "rename",
    selector,
    inputs: [],
    outputs: [],
    roots,
    rename,
    apply,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
  };
  if (!(await confirmOptions(rl, opts))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function interactiveRemove(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive remove\n"));
  const selector =
    partial.selector ||
    (await promptText(rl, "Component selector (e.g. abx-icon)", {
      required: true,
    }));
  let inputs = partial.inputs || [];
  let outputs = partial.outputs || [];
  if (!inputs.length && !outputs.length) {
    while (true) {
      const inputsRaw = await promptText(rl, "Inputs to remove (comma-separated)", {});
      const outputsRaw = await promptText(
        rl,
        "Outputs to remove (comma-separated)",
        {}
      );
      inputs = parseNameList(inputsRaw ? [inputsRaw] : []);
      outputs = parseNameList(outputsRaw ? [outputsRaw] : []);
      if (inputs.length || outputs.length) {
        break;
      }
      console.log(yellow("Provide at least one input or output."));
    }
  }
  const roots = await promptRoots(rl, partial.roots || []);
  let apply = partial.apply || false;
  if (!partial.apply) {
    apply = await promptYesNo(
      rl,
      "Apply changes to files now? (No = dry-run)",
      false
    );
  }
  const opts: CommandOptions = {
    command: "remove",
    selector,
    inputs,
    outputs,
    roots,
    apply,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
  };
  if (!(await confirmOptions(rl, opts))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function topLevelMenu(): Promise<"find" | "report" | "rename" | "remove"> {
  const rl = createRl();
  console.log(bold("Angular IO Tool"));
  console.log("  1) find    - locate input/output usages");
  console.log("  2) report  - write markdown/json report");
  console.log("  3) rename  - rename bindings (dry-run by default)");
  console.log("  4) remove  - remove bindings (dry-run by default)");
  console.log("  5) quit");
  while (true) {
    const choice = (await ask(rl, "Choose [1-5]: ")).trim();
    if (choice === "1" || choice.toLowerCase() === "find") {
      rl.close();
      return "find";
    }
    if (choice === "2" || choice.toLowerCase() === "report") {
      rl.close();
      return "report";
    }
    if (choice === "3" || choice.toLowerCase() === "rename") {
      rl.close();
      return "rename";
    }
    if (choice === "4" || choice.toLowerCase() === "remove") {
      rl.close();
      return "remove";
    }
    if (choice === "5" || choice.toLowerCase() === "q" || choice.toLowerCase() === "quit") {
      rl.close();
      process.exit(0);
    }
    console.log(yellow("Enter 1-5."));
  }
}

function needsInteractive(opts: Partial<CommandOptions>): boolean {
  if (opts.interactive) {
    return true;
  }
  if (!opts.command) {
    return true;
  }
  if (!opts.selector) {
    return true;
  }
  if (opts.command === "rename" && !(opts.rename && opts.rename.length)) {
    return true;
  }
  if (
    opts.command === "remove" &&
    !(opts.inputs && opts.inputs.length) &&
    !(opts.outputs && opts.outputs.length)
  ) {
    return true;
  }
  return false;
}

async function maybePrompt(
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  let command = partial.command;
  if (!command) {
    command = await topLevelMenu();
  }
  if (!needsInteractive({ ...partial, command })) {
    return {
      command,
      selector: partial.selector!,
      inputs: partial.inputs || [],
      outputs: partial.outputs || [],
      roots: partial.roots || [],
      rename: partial.rename,
      apply: partial.apply,
      format: partial.format,
      output: partial.output,
      interactive: false,
      log: partial.log,
      noLog: partial.noLog,
    };
  }

  const rl = createRl();
  try {
    const base = { ...partial, command };
    if (command === "find") {
      return await interactiveFind(rl, base);
    }
    if (command === "report") {
      return await interactiveReport(rl, base);
    }
    if (command === "rename") {
      return await interactiveRename(rl, base);
    }
    return await interactiveRemove(rl, base);
  } finally {
    rl.close();
  }
}

async function offerApplyAfterDryRun(
  opts: CommandOptions,
  runAgain: (apply: boolean) => Promise<void>
): Promise<void> {
  if (!opts.interactive || opts.apply) {
    return;
  }
  if (!process.stdin.isTTY) {
    return;
  }
  const rl = createRl();
  try {
    const yes = await promptYesNo(
      rl,
      "Dry-run complete. Apply these changes now?",
      false
    );
    if (yes) {
      console.log();
      await runAgain(true);
    }
  } finally {
    rl.close();
  }
}

// ---------------------------------------------------------------------------
// Command runners
// ---------------------------------------------------------------------------

function normalizeSelector(selector: string): string {
  let s = selector.trim();
  if (!s) {
    fail("--selector must not be empty");
  }
  if (s.startsWith("<") && s.endsWith(">")) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

async function runCommand(opts: CommandOptions): Promise<void> {
  const roots = normalizeRoots(opts.roots.length ? opts.roots : null);
  const selector = normalizeSelector(opts.selector);
  opts.selector = selector;

  console.log(dim(`Searching under ${roots.length} root(s):`));
  for (const root of roots) {
    console.log(dim(`  ${root}`));
  }
  console.log();

  let summaryRepos: string[] = [];
  let summaryFiles: string[] = [];

  if (opts.command === "rename") {
    const renameMap = parseRenameMap(opts.rename);
    if (!Object.keys(renameMap).length) {
      fail("Provide at least one --rename old=new pair");
    }
    const keys = Object.keys(renameMap);
    let usages = collectUsages(selector, roots, keys, keys);
    for (const usage of usages) {
      usage.bindings = usage.bindings.filter((b) => b.propertyName in renameMap);
    }
    usages = usages.filter((u) => u.bindings.length);
    const plans = planRenames(usages, renameMap);
    console.log(
      bold("Rename plan: ") +
        Object.entries(renameMap)
          .map(([oldName, newName]) => `${oldName} → ${newName}`)
          .join(", ")
    );
    console.log(bold(`Selector: <${selector}>\n`));
    const result = applyPlans(plans, Boolean(opts.apply));
    summaryRepos = result.repos;
    summaryFiles = result.files;

    const logPath = resolveLogPath(opts);
    writeRunLog(
      opts,
      roots,
      [
        `repos affected: ${summaryRepos.join(", ") || "(none)"}`,
        `files affected: ${summaryFiles.length}`,
        ...summaryFiles.map((f) => `  - ${f}`),
      ],
      logPath
    );

    await offerApplyAfterDryRun(opts, async (apply) => {
      const again = { ...opts, apply, interactive: false };
      // Avoid double-logging noise: temporarily disable auto header reprint by re-running core only
      const plans2 = planRenames(usages, renameMap);
      console.log(bold("Rename plan: ") + keys.map((k) => `${k} → ${renameMap[k]}`).join(", "));
      console.log(bold(`Selector: <${selector}>\n`));
      applyPlans(plans2, true);
      void again;
    });
    return;
  }

  const inputNames = opts.inputs;
  const outputNames = opts.outputs;
  if (opts.command === "remove" && !inputNames.length && !outputNames.length) {
    fail("Provide --inputs and/or --outputs");
  }

  const usages = collectUsages(selector, roots, inputNames, outputNames);

  if (opts.command === "find") {
    const result = printFindReport(usages, selector, inputNames, outputNames);
    summaryRepos = result.repos;
    summaryFiles = result.files;
  } else if (opts.command === "report") {
    const body =
      opts.format === "json"
        ? usagesToJson(usages, selector, inputNames, outputNames)
        : usagesToMarkdown(usages, selector, inputNames, outputNames);
    if (opts.output) {
      const outPath = path.resolve(opts.output);
      fs.writeFileSync(outPath, body, "utf8");
      console.log(green(`Wrote report to ${outPath}`));
      const result = printFindReport(usages, selector, inputNames, outputNames);
      summaryRepos = result.repos;
      summaryFiles = result.files;
    } else {
      console.log(body);
      summaryRepos = [...new Set(usages.map((u) => u.repo))];
      summaryFiles = [...new Set(usages.map((u) => u.filePath))];
    }
  } else if (opts.command === "remove") {
    const plans = planRemovals(usages, inputNames, outputNames);
    const targets: string[] = [];
    if (inputNames.length) {
      targets.push("inputs " + inputNames.join(", "));
    }
    if (outputNames.length) {
      targets.push("outputs " + outputNames.join(", "));
    }
    console.log(bold("Remove plan: ") + targets.join("; "));
    console.log(bold(`Selector: <${selector}>\n`));
    const result = applyPlans(plans, Boolean(opts.apply));
    summaryRepos = result.repos;
    summaryFiles = result.files;

    await offerApplyAfterDryRun(opts, async () => {
      console.log(bold("Remove plan: ") + targets.join("; "));
      console.log(bold(`Selector: <${selector}>\n`));
      applyPlans(plans, true);
    });
  }

  const logPath = resolveLogPath(opts);
  writeRunLog(
    opts,
    roots,
    [
      `repos affected: ${summaryRepos.join(", ") || "(none)"}`,
      `files affected: ${summaryFiles.length}`,
      ...summaryFiles.map((f) => `  - ${f}`),
    ],
    logPath
  );
}

// ---------------------------------------------------------------------------
// CLI (commander)
// ---------------------------------------------------------------------------

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option("--roots <paths...>", "Parent directories or repo paths to search")
    .option("--root <path>", "Additional search root (repeatable)", collect, [])
    .option("-i, --interactive", "Force interactive prompts", false)
    .option("--log <path>", "Write run log to this file")
    .option("--no-log", "Disable run logging");
}

function buildProgram(): {
  program: Command;
  getPartial: () => Partial<CommandOptions>;
} {
  let partial: Partial<CommandOptions> = {};

  const program = new Command();
  program
    .name("angular-io-tool")
    .description(
      "Find, rename, or remove Angular component input/output bindings across HTML templates using ripgrep."
    )
    .option("-i, --interactive", "Open interactive menu / force prompts", false)
    .option("--log <path>", "Write run log to this file")
    .option("--no-log", "Disable run logging")
    .action((options) => {
      partial = {
        interactive: true,
        log: options.log,
        noLog: options.log === false || process.argv.includes("--no-log"),
      };
    });

  const wire = (
    name: CommandOptions["command"],
    configure: (c: Command) => Command
  ): void => {
    const c = configure(
      addSharedOptions(
        program.command(name).allowUnknownOption(false)
      )
    );
    c.action((options: Record<string, unknown>) => {
      const roots = [
        ...((options.roots as string[]) || []),
        ...((options.root as string[]) || []),
      ];
      partial = {
        command: name,
        selector: (options.selector as string) || undefined,
        inputs: parseNameList((options.inputs as string[]) || []),
        outputs: parseNameList((options.outputs as string[]) || []),
        roots,
        rename: (options.rename as string[]) || undefined,
        apply: Boolean(options.apply),
        format:
          ((options.format as string) || "markdown") === "json"
            ? "json"
            : "markdown",
        output: (options.output as string) || undefined,
        interactive: Boolean(options.interactive),
        log:
          typeof options.log === "string"
            ? options.log
            : typeof program.opts().log === "string"
              ? (program.opts().log as string)
              : undefined,
        noLog:
          options.log === false ||
          program.opts().log === false ||
          process.argv.includes("--no-log"),
      };
    });
  };

  wire("find", (c) =>
    c
      .description("List usages of the component and selected bindings")
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
  );

  wire("report", (c) =>
    c
      .description("Write a Markdown or JSON usage report")
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
      .option("--format <fmt>", "Report format: markdown|json", "markdown")
      .option("-o, --output <path>", "Output file path (default: stdout)")
  );

  wire("rename", (c) =>
    c
      .description("Rename input/output bindings in HTML templates")
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--rename <pairs...>", "old=new pairs")
      .option("--apply", "Write changes to disk (default is dry-run)")
  );

  wire("remove", (c) =>
    c
      .description("Remove input/output bindings from HTML templates")
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
      .option("--apply", "Write changes to disk (default is dry-run)")
  );

  return {
    program,
    getPartial: () => partial,
  };
}

async function main(): Promise<void> {
  installConsoleTee();

  const { program, getPartial } = buildProgram();
  const argv = process.argv.slice(2);

  if (argv.length === 0) {
    const opts = await maybePrompt({
      interactive: true,
      noLog: false,
    });
    await runCommand(opts);
    return;
  }

  program.parse(process.argv);
  let partial = getPartial();

  // If user ran only `find` / `rename` etc., commander still fires action with empty opts.
  if (!partial.command && ["find", "report", "rename", "remove"].includes(argv[0])) {
    partial = { ...partial, command: argv[0] as CommandOptions["command"] };
  }

  const opts = await maybePrompt(partial);
  await runCommand(opts);
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
