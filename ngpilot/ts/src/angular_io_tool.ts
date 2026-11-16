#!/usr/bin/env node
/**
 * ngpilot — find, rename, or remove Angular component input/output bindings
 * in HTML templates across one or many repositories.
 *
 * Examples:
 *   ngpilot find --selector abx-icon --inputs isCustomIcon,isUtilityIcon
 *   ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom --apply
 *   ngpilot find
 */

import { spawnSync } from "child_process";
import { Command } from "commander";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";
import { runCommitCommand } from "./commit";
import { resolveGithubUserName } from "./github_user";
import { gitRemoteUrl, gitTopLevel, pathRelativeToRepo } from "./git/local";
import {
  appendImpactRecords,
  buildImpactRecords,
  ImpactChangeInput,
} from "./impact";
import {
  ensureDir,
  persistImpactLog,
  persistLogsDir,
  persistRoots,
  persistRunsDir,
  resolveImpactLogPaths,
  resolveLogsDir,
  resolveRootsInput,
  resolveRunsDir,
  USER_CONFIG_HINT,
} from "./paths";
import {
  printFixIoNamesSummary,
  runFixIoNames,
} from "./fix_io_names";
import {
  printRemoveUnusedSummary,
  runRemoveUnused,
} from "./remove_unused";
import {
  ChangeRun,
  generateRunHash,
  saveChangeRun,
  setRunsDir,
} from "./runs";
import { loadUserConfig } from "./user_config";

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
  attributeAffected: string;
  notes: string;
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
  command:
    | "find"
    | "report"
    | "rename"
    | "remove"
    | "remove-unused"
    | "fix-io-names"
    | "commit";
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
  impactLog?: string;
  logsDir?: string;
  runsDir?: string;
  nameDict?: string;
  // commit-only
  commitHash?: string;
  /** One or more change-run hashes (multi-hash commit). */
  commitHashes?: string[];
  branchName?: string;
  targetBranch?: string;
  commitTitle?: string;
  commitBody?: string;
  commitDryRun?: boolean;
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
  const logsDir = resolveLogsDir().dir;
  ensureDir(logsDir);
  return path.join(logsDir, `run-${stamp}.log`);
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

function indexInsideQuotes(text: string, index: number): boolean {
  let inQuote: string | null = null;
  let i = 0;
  while (i < text.length && i < index) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    }
    i += 1;
  }
  return inQuote !== null;
}

function attrPatterns(name: string): Array<[string, RegExp]> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = String.raw`(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?`;
  return [
    ["two-way", new RegExp(String.raw`\[\(${esc}\)\]${value}`, "g")],
    ["property", new RegExp(String.raw`\[${esc}\]${value}`, "g")],
    ["output", new RegExp(String.raw`\(${esc}\)${value}`, "g")],
    // Attribute name only — never match inside quoted values (checked separately).
    [
      "attribute",
      new RegExp(
        String.raw`(?<![\w.\-\[\(\)\]#/])\b${esc}\b` +
          String.raw`(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?=[\s/>]))`,
        "g"
      ),
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
        // Skip names that only appear inside quoted values
        // e.g. *ngIf="...=='table'" or [abcd]="obj.isCustomIcon".
        if (indexInsideQuotes(tagText, localStart)) {
          continue;
        }
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
            attributeAffected: binding.propertyName,
            notes: `Renamed ${binding.propertyName} to ${newCanonical}`,
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
            attributeAffected: binding.propertyName,
            notes: `Removed ${binding.propertyName}`,
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

function recordAppliedRun(
  plans: FileChangePlan[],
  meta: {
    command: "rename" | "remove";
    selector: string;
    roots: string[];
    inputs: string[];
    outputs: string[];
    renameMap?: Record<string, string>;
  }
): string | null {
  if (!plans.length) {
    return null;
  }
  const byGitRoot = new Map<string, FileChangePlan[]>();
  for (const plan of plans) {
    const root =
      gitTopLevel(path.dirname(plan.filePath)) ||
      path.dirname(plan.filePath);
    const list = byGitRoot.get(root) || [];
    list.push(plan);
    byGitRoot.set(root, list);
  }

  const repos: ChangeRun["repos"] = [];
  for (const [repoRoot, repoPlans] of byGitRoot) {
    repos.push({
      repoRoot,
      repoName: path.basename(repoRoot),
      remoteUrl: gitRemoteUrl(repoRoot),
      files: repoPlans.map((plan) => ({
        absolutePath: plan.filePath,
        relativePath: pathRelativeToRepo(repoRoot, plan.filePath),
        before: plan.original,
        after: plan.updated,
      })),
    });
  }

  const partial: Omit<ChangeRun, "hash"> = {
    createdAt: new Date().toISOString(),
    command: meta.command,
    selector: meta.selector,
    renameMap: meta.renameMap,
    inputs: meta.inputs,
    outputs: meta.outputs,
    roots: meta.roots,
    repos,
  };
  const hash = generateRunHash(partial);
  const run: ChangeRun = { hash, ...partial };
  const file = saveChangeRun(run);
  console.log();
  console.log(green(`Change run recorded: ${bold(hash)}`));
  console.log(dim(`  Saved to ${file}`));
  console.log(
    dim(
      `  Commit locally later with: ngpilot commit ${hash} --branch-name <name> --target-branch <base> --title "<msg>"`
    )
  );
  return hash;
}

async function writeImpactLogForPlans(
  plans: FileChangePlan[],
  runMeta: {
    command: "rename" | "remove";
    selector: string;
    impactLog?: string;
    interactive?: boolean;
  }
): Promise<void> {
  const changes: ImpactChangeInput[] = [];
  for (const plan of plans) {
    for (const detail of plan.details) {
      changes.push({
        filePath: plan.filePath,
        repo: plan.repo,
        line: detail.line,
        attributeAffected: detail.attributeAffected,
        notes: detail.notes,
      });
    }
  }
  if (!changes.length) {
    return;
  }

  const githubUserName = await resolveGithubUserName({
    prompt:
      runMeta.interactive && process.stdin.isTTY
        ? async () => {
            const rl = createRl();
            try {
              return await promptText(
                rl,
                "GitHub username (saved to ~/.ngpilot/config.json)",
                { required: false }
              );
            } finally {
              rl.close();
            }
          }
        : undefined,
  });

  const records = buildImpactRecords({
    githubUserName,
    selector: runMeta.selector,
    operation: runMeta.command,
    changes,
  });
  const written = appendImpactRecords(records, runMeta.impactLog);
  console.log();
  console.log(
    green(
      `Impact log: wrote ${written.count} record(s)`
    )
  );
  console.log(dim(`  JSON: ${written.jsonPath}`));
  console.log(dim(`  CSV:  ${written.csvPath}`));
}

async function applyPlans(
  plans: FileChangePlan[],
  apply: boolean,
  runMeta?: {
    command: "rename" | "remove";
    selector: string;
    roots: string[];
    inputs: string[];
    outputs: string[];
    renameMap?: Record<string, string>;
    impactLog?: string;
    interactive?: boolean;
  }
): Promise<{ repos: string[]; files: string[]; runHash?: string }> {
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

  let runHash: string | undefined;
  if (apply) {
    for (const plan of plans) {
      fs.writeFileSync(plan.filePath, plan.updated, "utf8");
    }
    console.log();
    console.log(
      green(`Wrote ${plans.length} file(s).`) +
        " Review the diffs in GitHub Desktop (or git diff), then commit with the commit command."
    );
    if (runMeta) {
      runHash = recordAppliedRun(plans, runMeta) || undefined;
      await writeImpactLogForPlans(plans, runMeta);
    }
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
    runHash,
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
  opts: {
    defaultValue?: string;
    required?: boolean;
    /** When false, typing q returns "q" instead of exiting the process. */
    exitOnQuit?: boolean;
  } = {}
): Promise<string> {
  const { defaultValue, required, exitOnQuit = true } = opts;
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
      if (!exitOnQuit) {
        return "q";
      }
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

async function promptUnusedDecision(
  rl: readline.Interface,
  label: string
): Promise<"yes" | "no" | "nc" | "nr" | "q"> {
  while (true) {
    const raw = (await ask(rl, `${label} [Y/n/nc/nr/q]: `)).trim().toLowerCase();
    if (!raw || raw === "n" || raw === "no") {
      return "no";
    }
    if (raw === "y" || raw === "yes") {
      return "yes";
    }
    if (raw === "nc") {
      return "nc";
    }
    if (raw === "nr") {
      return "nr";
    }
    if (raw === "q" || raw === "quit") {
      return "q";
    }
    console.log(yellow("Please answer Y, N, NC, NR, or Q."));
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
  const resolved = resolveRootsInput(null);
  if (resolved.roots && resolved.roots.length) {
    console.log(
      dim(
        `Using repository roots from ${resolved.source}` +
          (resolved.source === "env" ? " (NGPILOT_ROOTS)" : "") +
          `: ${resolved.roots.join("; ")}`
      )
    );
    return resolved.roots;
  }
  const raw = await promptText(
    rl,
    "Roots (paths separated by ; — Enter = current directory)",
    { defaultValue: process.cwd() }
  );
  if (!raw || raw === process.cwd()) {
    persistRoots([]);
    return [];
  }
  const roots = raw.split(/[;]+/).map((s) => s.trim()).filter(Boolean);
  persistRoots(roots);
  return roots;
}

function hasEnvOrConfigLogsDir(): boolean {
  return Boolean(process.env.NGPILOT_LOGS?.trim() || loadUserConfig().logsDir);
}

function hasEnvOrConfigRunsDir(): boolean {
  return Boolean(process.env.NGPILOT_RUNS?.trim() || loadUserConfig().runsDir);
}

function hasEnvOrConfigImpactLog(): boolean {
  return Boolean(
    process.env.NGPILOT_IMPACT_LOG?.trim() || loadUserConfig().impactLog
  );
}

/**
 * Prompt once for logs-dir / runs-dir / impact-log when not set via CLI/env/config.
 * Persists answers to ~/.ngpilot/config.json.
 */
async function ensurePersistentPaths(
  rl: readline.Interface,
  partial: Partial<CommandOptions>,
  options: { needImpact: boolean }
): Promise<{
  logsDir?: string;
  runsDir?: string;
  impactLog?: string;
}> {
  let logsDir = partial.logsDir;
  let runsDir = partial.runsDir;
  let impactLog = partial.impactLog;

  if (logsDir) {
    persistLogsDir(logsDir);
  } else if (!hasEnvOrConfigLogsDir()) {
    const fallback = resolveLogsDir().dir;
    const raw = await promptText(
      rl,
      `Logs directory (Enter = ${fallback})`,
      { defaultValue: fallback }
    );
    logsDir = path.resolve(raw || fallback);
    persistLogsDir(logsDir);
  }

  const logsResolved = resolveLogsDir(logsDir);
  if (runsDir) {
    persistRunsDir(runsDir);
  } else if (!hasEnvOrConfigRunsDir()) {
    const fallback = resolveRunsDir(null, logsResolved).dir;
    const raw = await promptText(
      rl,
      `Change-runs directory (Enter = ${fallback})`,
      { defaultValue: fallback }
    );
    runsDir = path.resolve(raw || fallback);
    persistRunsDir(runsDir);
  }

  if (options.needImpact) {
    if (impactLog) {
      persistImpactLog(impactLog);
    } else if (!hasEnvOrConfigImpactLog()) {
      const fallback = resolveImpactLogPaths(null).configuredPath;
      const raw = await promptText(
        rl,
        `Impact log path (.csv or .json; sibling pair kept) (Enter = ${fallback})`,
        { defaultValue: fallback }
      );
      impactLog = path.resolve(raw || fallback);
      persistImpactLog(impactLog);
    }
  }

  return { logsDir, runsDir, impactLog };
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
    if (opts.impactLog) {
      console.log(`  impact:   ${opts.impactLog}`);
    }
  }
  if (opts.logsDir) {
    console.log(`  logs-dir: ${opts.logsDir}`);
  }
  if (opts.runsDir) {
    console.log(`  runs-dir: ${opts.runsDir}`);
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
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: false });
  const opts: CommandOptions = {
    command: "find",
    selector,
    inputs: parseNameList(inputsRaw ? [inputsRaw] : []),
    outputs: parseNameList(outputsRaw ? [outputsRaw] : []),
    roots,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
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
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: false });
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
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
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
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: true });
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
    impactLog: paths.impactLog || partial.impactLog,
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
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
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: true });
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
    impactLog: paths.impactLog || partial.impactLog,
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
  };
  if (!(await confirmOptions(rl, opts))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function topLevelMenu(): Promise<CommandOptions["command"]> {
  const rl = createRl();
  console.log(bold("ngpilot"));
  console.log("  1) find           - locate input/output usages");
  console.log("  2) report         - write markdown/json report");
  console.log("  3) rename         - rename bindings (dry-run by default)");
  console.log("  4) remove         - remove bindings (dry-run by default)");
  console.log("  5) remove-unused  - find unused @Input/@Output and remove");
  console.log("  6) fix-io-names   - fix @Input/@Output naming standards");
  console.log("  7) commit         - local commit of recorded change run(s)");
  console.log("  8) quit");
  while (true) {
    const choice = (await ask(rl, "Choose [1-8]: ")).trim();
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
    if (
      choice === "5" ||
      choice.toLowerCase() === "remove-unused" ||
      choice.toLowerCase() === "unused"
    ) {
      rl.close();
      return "remove-unused";
    }
    if (
      choice === "6" ||
      choice.toLowerCase() === "fix-io-names" ||
      choice.toLowerCase() === "fix-names"
    ) {
      rl.close();
      return "fix-io-names";
    }
    if (choice === "7" || choice.toLowerCase() === "commit") {
      rl.close();
      return "commit";
    }
    if (choice === "8" || choice.toLowerCase() === "q" || choice.toLowerCase() === "quit") {
      rl.close();
      process.exit(0);
    }
    console.log(yellow("Enter 1-8."));
  }
}

function needsInteractive(opts: Partial<CommandOptions>): boolean {
  if (opts.interactive) {
    return true;
  }
  if (!opts.command) {
    return true;
  }
  if (opts.command === "remove-unused" || opts.command === "fix-io-names") {
    // Always interactive for per-attribute decisions / inline parse prompts.
    return true;
  }
  if (opts.command === "commit") {
    const hashes =
      opts.commitHashes && opts.commitHashes.length
        ? opts.commitHashes
        : opts.commitHash
          ? [opts.commitHash]
          : [];
    return !(
      hashes.length &&
      opts.branchName &&
      opts.targetBranch &&
      opts.commitTitle
    );
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

async function interactiveCommit(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive commit (local only — no push/PR)\n"));
  let commitHashes =
    partial.commitHashes && partial.commitHashes.length
      ? partial.commitHashes
      : partial.commitHash
        ? [partial.commitHash]
        : [];
  if (!commitHashes.length) {
    const raw = await promptText(
      rl,
      "Change run hash id(s) (space-separated for multiple)",
      { required: true }
    );
    commitHashes = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  }
  const branchName =
    partial.branchName ||
    (await promptText(rl, "Feature branch name (--branch-name)", {
      required: true,
    }));
  const targetBranch =
    partial.targetBranch ||
    (await promptText(rl, "Base branch to create from (--target-branch)", {
      required: true,
    }));
  const commitTitle =
    partial.commitTitle ||
    (await promptText(rl, "Commit title", { required: true }));
  const commitBody =
    partial.commitBody !== undefined
      ? partial.commitBody
      : await promptText(rl, "Commit description (optional)", {});

  const opts: CommandOptions = {
    command: "commit",
    selector: "",
    inputs: [],
    outputs: [],
    roots: [],
    commitHash: commitHashes[0],
    commitHashes,
    branchName,
    targetBranch,
    commitTitle,
    commitBody,
    commitDryRun: partial.commitDryRun,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
    logsDir: partial.logsDir,
    runsDir: partial.runsDir,
  };

  console.log();
  console.log(bold("About to run local commit:"));
  console.log(`  hash(es):       ${commitHashes.join(", ")}`);
  console.log(`  branch-name:    ${opts.branchName}`);
  console.log(`  target-branch:  ${opts.targetBranch}`);
  console.log(`  title:          ${opts.commitTitle}`);
  console.log(`  body:           ${opts.commitBody || "(none)"}`);
  console.log();
  if (!(await promptYesNo(rl, "Proceed?", true))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function interactiveRemoveUnused(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive remove-unused\n"));
  console.log(
    dim(
      "Scans @Component @Input/@Output APIs, finds unused HTML bindings, and prompts before each deletion."
    )
  );
  const roots = await promptRoots(rl, partial.roots || []);
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: true });
  const opts: CommandOptions = {
    command: "remove-unused",
    selector: "",
    inputs: [],
    outputs: [],
    roots,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
    impactLog: paths.impactLog || partial.impactLog,
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
  };
  console.log();
  console.log(bold("About to run:"));
  console.log(`  command:  remove-unused`);
  console.log(
    `  roots:    ${opts.roots.length ? opts.roots.join("; ") : "(cwd)"}`
  );
  console.log();
  if (!(await promptYesNo(rl, "Proceed?", true))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
}

async function interactiveFixIoNames(
  rl: readline.Interface,
  partial: Partial<CommandOptions>
): Promise<CommandOptions> {
  console.log(bold("\nInteractive fix-io-names\n"));
  console.log(
    dim(
      "Scans @Component @Input/@Output names for standards (no output 'on' prefix; camelCase), prompts before each rename."
    )
  );
  const roots = await promptRoots(rl, partial.roots || []);
  const paths = await ensurePersistentPaths(rl, partial, { needImpact: true });
  let nameDict = partial.nameDict;
  if (!nameDict && !process.env.NGPILOT_NAME_DICT?.trim()) {
    const raw = await promptText(
      rl,
      "Optional custom name dictionary file (Enter = built-in only)",
      { required: false, exitOnQuit: false }
    );
    if (raw.toLowerCase() === "q") {
      console.log("Cancelled.");
      process.exit(130);
    }
    if (raw.trim()) {
      nameDict = raw.trim();
    }
  }
  const opts: CommandOptions = {
    command: "fix-io-names",
    selector: "",
    inputs: [],
    outputs: [],
    roots,
    interactive: true,
    log: partial.log,
    noLog: partial.noLog,
    impactLog: paths.impactLog || partial.impactLog,
    logsDir: paths.logsDir || partial.logsDir,
    runsDir: paths.runsDir || partial.runsDir,
    nameDict,
  };
  console.log();
  console.log(bold("About to run:"));
  console.log(`  command:   fix-io-names`);
  console.log(
    `  roots:     ${opts.roots.length ? opts.roots.join("; ") : "(cwd)"}`
  );
  console.log(
    `  name-dict: ${
      nameDict ||
      process.env.NGPILOT_NAME_DICT?.trim() ||
      "(built-in)"
    }`
  );
  console.log();
  if (!(await promptYesNo(rl, "Proceed?", true))) {
    console.log("Cancelled.");
    process.exit(130);
  }
  return opts;
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
      selector: partial.selector || "",
      inputs: partial.inputs || [],
      outputs: partial.outputs || [],
      // Keep CLI roots only; env/config roots are resolved in runCommand
      // so environment overrides are not written back to user config.
      roots: partial.roots || [],
      rename: partial.rename,
      apply: partial.apply,
      format: partial.format,
      output: partial.output,
      interactive: false,
      log: partial.log,
      noLog: partial.noLog,
      impactLog: partial.impactLog,
      logsDir: partial.logsDir,
      runsDir: partial.runsDir,
      nameDict: partial.nameDict,
      commitHash: partial.commitHash,
      commitHashes: partial.commitHashes,
      branchName: partial.branchName,
      targetBranch: partial.targetBranch,
      commitTitle: partial.commitTitle,
      commitBody: partial.commitBody,
      commitDryRun: partial.commitDryRun,
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
    if (command === "remove") {
      return await interactiveRemove(rl, base);
    }
    if (command === "remove-unused") {
      return await interactiveRemoveUnused(rl, base);
    }
    if (command === "fix-io-names") {
      return await interactiveFixIoNames(rl, base);
    }
    return await interactiveCommit(rl, base);
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

async function executeCommit(opts: CommandOptions): Promise<void> {
  const hashes =
    opts.commitHashes && opts.commitHashes.length
      ? opts.commitHashes
      : opts.commitHash
        ? [opts.commitHash]
        : [];
  if (!hashes.length) {
    fail("Provide one or more change run hashes (arguments or --hash)");
  }
  if (!opts.branchName) {
    fail("Provide --branch-name");
  }
  if (!opts.targetBranch) {
    fail("Provide --target-branch");
  }
  if (!opts.commitTitle) {
    fail("Provide --title");
  }

  console.log(bold("Local commit (no push / no PR)"));
  console.log(`  hash(es):      ${hashes.join(", ")}`);
  console.log(`  branch-name:   ${opts.branchName}`);
  console.log(`  target-branch: ${opts.targetBranch}`);
  console.log(`  title:         ${opts.commitTitle}`);
  console.log();

  const allSuccessLines: string[] = [];
  const logExtra: string[] = [];
  let lastRoots: string[] = [];

  for (const hash of hashes) {
    console.log(bold(`--- change run ${hash} ---`));
    const { run, results } = await runCommitCommand({
      hash,
      branchName: opts.branchName,
      targetBranch: opts.targetBranch,
      title: opts.commitTitle,
      body: opts.commitBody || "",
      dryRun: Boolean(opts.commitDryRun),
    });
    lastRoots = run.roots;
    logExtra.push(`change run: ${run.hash}`);
    for (const result of results) {
      if (result.error) {
        console.log(red(`  ✗ ${result.repoName}: ${result.error}`));
        logExtra.push(`  error ${result.repoName}: ${result.error}`);
      } else {
        console.log(green(`  ✓ ${result.repoName}`));
        console.log(`      branch: ${result.branchName}`);
        if (result.commitSha) {
          console.log(dim(`      commit: ${result.commitSha}`));
        }
        const line = `${result.repoName}\t${result.branchName}\t${
          result.commitSha || ""
        }\t${hash}`;
        allSuccessLines.push(line);
        logExtra.push(`  - ${line}`);
      }
      if (result.warnings?.length) {
        for (const warning of result.warnings) {
          console.log(yellow(`      warning: ${warning}`));
        }
      }
    }
    console.log();
  }

  if (allSuccessLines.length) {
    console.log(bold("Local commits ready (repo / branch / sha / hash):"));
    for (const line of allSuccessLines) {
      console.log(`  ${line}`);
    }
    console.log(
      dim(
        "Checkout each branch locally, push when ready, then open PRs yourself."
      )
    );
  }

  const logPath = resolveLogPath(opts);
  writeRunLog(
    opts,
    lastRoots,
    [
      `hashes: ${hashes.join(", ")}`,
      `branch: ${opts.branchName}`,
      `target: ${opts.targetBranch}`,
      `title: ${opts.commitTitle}`,
      "local commits:",
      ...(allSuccessLines.length
        ? allSuccessLines.map((l) => `  - ${l}`)
        : ["  (none)"]),
      ...logExtra.filter((l) => l.startsWith("  error")),
    ],
    logPath
  );
}

async function executeRemoveUnused(
  opts: CommandOptions,
  roots: string[]
): Promise<void> {
  console.log(bold("remove-unused"));
  console.log(
    dim(
      "Indexing @Component files, checking HTML usages, prompting only for unused attributes."
    )
  );
  console.log();

  const rl = createRl();
  try {
    const summary = await runRemoveUnused(roots, {
      skipDirNames: SKIP_DIR_NAMES,
      collectUsages: (selector, searchRoots, inputs, outputs) =>
        collectUsages(selector, searchRoots, inputs, outputs),
      removeHtmlApply: async ({
        selector,
        roots: searchRoots,
        inputs,
        outputs,
        impactLog,
      }) => {
        const usages = collectUsages(selector, searchRoots, inputs, outputs);
        const plans = planRemovals(usages, inputs, outputs);
        const result = await applyPlans(plans, true, {
          command: "remove",
          selector,
          roots: searchRoots,
          inputs,
          outputs,
          impactLog: impactLog || opts.impactLog,
          interactive: true,
        });
        return {
          repos: result.repos,
          files: result.files,
          runHash: result.runHash,
        };
      },
      promptText: (message, promptOpts) =>
        promptText(rl, message, {
          ...(promptOpts || {}),
          exitOnQuit: false,
        }),
      promptUnusedDecision: (message) => promptUnusedDecision(rl, message),
      log: opts.log,
      impactLog: opts.impactLog,
      onProgress: (message) => console.log(dim(message)),
    });

    const transcript = resolveLogPath(opts);
    if (transcript) {
      summary.transcriptLogPath = transcript;
    }
    printRemoveUnusedSummary(summary);

    writeRunLog(
      opts,
      roots,
      [
        `remove-unused summary`,
        `quitMidRun: ${summary.quitMidRun}`,
        `components scanned: ${summary.componentsScanned}`,
        `unused found: ${summary.unusedFound}`,
        `removed: ${summary.removed}`,
        `skipped N/NC/NR: ${summary.skippedByUser}/${summary.skippedViaNc}/${summary.skippedViaNr}`,
        `tsRemovalWarnings: ${summary.tsRemovalWarnings}`,
        `affected repos: ${summary.affectedRepos.join(", ") || "(none)"}`,
        `hashes: ${summary.changeRunHashes.join(" ") || "(none)"}`,
        `detail log: ${summary.logPath}`,
        ...(summary.impactJsonPath
          ? [`impact json: ${summary.impactJsonPath}`]
          : []),
        ...(summary.impactCsvPath
          ? [`impact csv: ${summary.impactCsvPath}`]
          : []),
      ],
      transcript
    );
  } finally {
    rl.close();
  }
}

async function executeFixIoNames(
  opts: CommandOptions,
  roots: string[]
): Promise<void> {
  console.log(bold("fix-io-names"));
  console.log(
    dim(
      "Scanning @Input/@Output names for standards; prompting before each rename."
    )
  );
  console.log();

  const rl = createRl();
  try {
    const summary = await runFixIoNames(roots, {
      skipDirNames: SKIP_DIR_NAMES,
      nameDictFiles: opts.nameDict ? [opts.nameDict] : [],
      renameHtmlApply: async ({
        selector,
        roots: searchRoots,
        renameMap,
        impactLog,
      }) => {
        const keys = Object.keys(renameMap);
        let usages = collectUsages(selector, searchRoots, keys, keys);
        for (const usage of usages) {
          usage.bindings = usage.bindings.filter(
            (b) => b.propertyName in renameMap
          );
        }
        usages = usages.filter((u) => u.bindings.length);
        const plans = planRenames(usages, renameMap);
        if (!plans.length) {
          return { repos: [], files: [] };
        }
        const result = await applyPlans(plans, true, {
          command: "rename",
          selector,
          roots: searchRoots,
          inputs: keys,
          outputs: keys,
          renameMap,
          impactLog: impactLog || opts.impactLog,
          interactive: true,
        });
        return {
          repos: result.repos,
          files: result.files,
          runHash: result.runHash,
        };
      },
      promptText: (message, promptOpts) =>
        promptText(rl, message, {
          ...(promptOpts || {}),
          exitOnQuit: promptOpts?.exitOnQuit ?? false,
        }),
      promptFixDecision: (message) => promptUnusedDecision(rl, message),
      log: opts.log,
      impactLog: opts.impactLog,
      onProgress: (message) => console.log(dim(message)),
    });

    const transcript = resolveLogPath(opts);
    if (transcript) {
      summary.transcriptLogPath = transcript;
    }
    printFixIoNamesSummary(summary);

    writeRunLog(
      opts,
      roots,
      [
        `fix-io-names summary`,
        `quitMidRun: ${summary.quitMidRun}`,
        `components scanned: ${summary.componentsScanned}`,
        `violations found: ${summary.violationsFound}`,
        `renamed: ${summary.renamed}`,
        `skipped N/NC/NR: ${summary.skippedByUser}/${summary.skippedViaNc}/${summary.skippedViaNr}`,
        `tsRenameWarnings: ${summary.tsRenameWarnings}`,
        `affected repos: ${summary.affectedRepos.join(", ") || "(none)"}`,
        `hashes: ${summary.changeRunHashes.join(" ") || "(none)"}`,
        `detail log: ${summary.logPath}`,
        ...(summary.impactJsonPath
          ? [`impact json: ${summary.impactJsonPath}`]
          : []),
        ...(summary.impactCsvPath
          ? [`impact csv: ${summary.impactCsvPath}`]
          : []),
      ],
      transcript
    );
  } finally {
    rl.close();
  }
}

function applyRuntimePaths(opts: CommandOptions): void {
  if (opts.logsDir) {
    persistLogsDir(opts.logsDir);
  }
  if (opts.runsDir) {
    persistRunsDir(opts.runsDir);
  }
  if (opts.impactLog) {
    persistImpactLog(opts.impactLog);
  }
  const logs = resolveLogsDir(opts.logsDir);
  const runs = resolveRunsDir(opts.runsDir, logs);
  setRunsDir(runs.dir);
  ensureDir(logs.dir);
  ensureDir(runs.dir);
}

function argvHasFlag(...flags: string[]): boolean {
  for (const arg of process.argv) {
    for (const flag of flags) {
      if (arg === flag || arg.startsWith(flag + "=")) {
        return true;
      }
    }
  }
  return false;
}

async function runCommand(opts: CommandOptions): Promise<void> {
  applyRuntimePaths(opts);

  if (opts.command === "commit") {
    await executeCommit(opts);
    return;
  }

  const rootsFromCli = argvHasFlag("--roots", "--root");
  let rootsInput: string[] | null | undefined;
  if (rootsFromCli) {
    if (opts.roots.length) {
      persistRoots(opts.roots);
    }
    rootsInput = opts.roots.length ? opts.roots : null;
  } else if (opts.interactive) {
    // Interactive promptRoots already persisted when appropriate.
    rootsInput = opts.roots.length ? opts.roots : resolveRootsInput(null).roots;
  } else {
    rootsInput = resolveRootsInput(null).roots ?? null;
  }
  const roots = normalizeRoots(rootsInput ?? null);

  if (opts.command === "remove-unused") {
    await executeRemoveUnused(opts, roots);
    return;
  }

  if (opts.command === "fix-io-names") {
    await executeFixIoNames(opts, roots);
    return;
  }

  const selector = normalizeSelector(opts.selector);
  opts.selector = selector;

  console.log(dim(`Searching under ${roots.length} root(s):`));
  for (const root of roots) {
    console.log(dim(`  ${root}`));
  }
  console.log();

  let summaryRepos: string[] = [];
  let summaryFiles: string[] = [];
  let runHash: string | undefined;

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
    const runMeta = {
      command: "rename" as const,
      selector,
      roots: roots.map(String),
      inputs: keys,
      outputs: keys,
      renameMap,
      impactLog: opts.impactLog,
      interactive: Boolean(opts.interactive),
    };
    const result = await applyPlans(plans, Boolean(opts.apply), runMeta);
    summaryRepos = result.repos;
    summaryFiles = result.files;
    runHash = result.runHash;

    const logPath = resolveLogPath(opts);
    writeRunLog(
      opts,
      roots,
      [
        `repos affected: ${summaryRepos.join(", ") || "(none)"}`,
        `files affected: ${summaryFiles.length}`,
        ...(runHash ? [`change run hash: ${runHash}`] : []),
        ...summaryFiles.map((f) => `  - ${f}`),
      ],
      logPath
    );

    await offerApplyAfterDryRun(opts, async () => {
      const plans2 = planRenames(usages, renameMap);
      console.log(
        bold("Rename plan: ") +
          keys.map((k) => `${k} → ${renameMap[k]}`).join(", ")
      );
      console.log(bold(`Selector: <${selector}>\n`));
      await applyPlans(plans2, true, runMeta);
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
    const runMeta = {
      command: "remove" as const,
      selector,
      roots: roots.map(String),
      inputs: inputNames,
      outputs: outputNames,
      impactLog: opts.impactLog,
      interactive: Boolean(opts.interactive),
    };
    const result = await applyPlans(plans, Boolean(opts.apply), runMeta);
    summaryRepos = result.repos;
    summaryFiles = result.files;
    runHash = result.runHash;

    await offerApplyAfterDryRun(opts, async () => {
      console.log(bold("Remove plan: ") + targets.join("; "));
      console.log(bold(`Selector: <${selector}>\n`));
      await applyPlans(plans, true, runMeta);
    });
  }

  const logPath = resolveLogPath(opts);
  writeRunLog(
    opts,
    roots,
    [
      `repos affected: ${summaryRepos.join(", ") || "(none)"}`,
      `files affected: ${summaryFiles.length}`,
      ...(runHash ? [`change run hash: ${runHash}`] : []),
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

const CONFIG_HELP = `
Configuration priority (highest first): CLI flag → environment variable →
saved config (${USER_CONFIG_HINT}) → interactive prompt → built-in defaults.

Environment variables:
  NGPILOT_ROOTS         ;-separated repository roots
  NGPILOT_LOGS          directory for run-*.log transcripts
  NGPILOT_RUNS          directory for change-run JSON files
  NGPILOT_IMPACT_LOG    path to impact .csv/.json (sibling pair is maintained)
  NGPILOT_GITHUB_USER   GitHub username for impact records (fallback: GITHUB_USER)
  NGPILOT_NAME_DICT     optional extra word list for fix-io-names (one word/line)

PowerShell examples:
  $env:NGPILOT_ROOTS = "D:\\angular-repos;D:\\other-repos"
  $env:NGPILOT_IMPACT_LOG = "D:\\folder\\nested\\their_file_name.csv"
  $env:NGPILOT_NAME_DICT = "D:\\path\\my-words.txt"
  [System.Environment]::SetEnvironmentVariable("NGPILOT_ROOTS", "D:\\angular-repos", "User")
`.trim();

function addSharedOptions(cmd: Command): Command {
  return cmd
    .option(
      "--roots <paths...>",
      "Parent directories or repo paths to search (overrides NGPILOT_ROOTS; saved to user config)"
    )
    .option("--root <path>", "Additional search root (repeatable)", collect, [])
    .option(
      "--logs-dir <path>",
      "Directory for run-*.log transcripts (overrides NGPILOT_LOGS; saved to user config)"
    )
    .option(
      "--runs-dir <path>",
      "Directory for change-run JSON files (overrides NGPILOT_RUNS; saved to user config)"
    )
    .option("-i, --interactive", "Force interactive prompts", false)
    .option("--log <path>", "Write this run's transcript to this file")
    .option("--no-log", "Disable run logging");
}

function buildProgram(): {
  program: Command;
  getPartial: () => Partial<CommandOptions>;
} {
  let partial: Partial<CommandOptions> = {};

  const program = new Command();
  program
    .name("ngpilot")
    .description(
      [
        "Multi-repo Angular template tooling: find, report, rename, remove,",
        "remove-unused, fix-io-names (@Input/@Output naming standards), then",
        "optionally create local commits from recorded apply runs.",
        "",
        CONFIG_HELP,
      ].join("\n")
    )
    .option("-i, --interactive", "Open interactive menu / force prompts", false)
    .option("--log <path>", "Write this run's transcript to this file")
    .option("--no-log", "Disable run logging")
    .addHelpText("after", `\n${CONFIG_HELP}\n`)
    .action((options) => {
      partial = {
        interactive: true,
        log: options.log,
        noLog: options.log === false || process.argv.includes("--no-log"),
      };
    });

  const wire = (
    name: Exclude<
      CommandOptions["command"],
      "commit" | "remove-unused" | "fix-io-names"
    >,
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
        impactLog:
          typeof options.impactLog === "string"
            ? (options.impactLog as string)
            : undefined,
        logsDir:
          typeof options.logsDir === "string"
            ? (options.logsDir as string)
            : undefined,
        runsDir:
          typeof options.runsDir === "string"
            ? (options.runsDir as string)
            : undefined,
      };
    });
  };

  wire("find", (c) =>
    c
      .description(
        "List usages of the component and selected bindings. Roots: --roots, NGPILOT_ROOTS, saved config, or cwd."
      )
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
      .addHelpText("after", `\n${CONFIG_HELP}\n`)
  );

  wire("report", (c) =>
    c
      .description(
        "Write a Markdown or JSON usage report. Roots: --roots, NGPILOT_ROOTS, saved config, or cwd."
      )
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
      .option("--format <fmt>", "Report format: markdown|json", "markdown")
      .option("-o, --output <path>", "Output file path (default: stdout)")
      .addHelpText("after", `\n${CONFIG_HELP}\n`)
  );

  wire("rename", (c) =>
    c
      .description(
        [
          "Rename input/output bindings in HTML templates (dry-run by default).",
          "With --apply: writes files, records a change-run hash, and appends",
          "one impact row per binding change to the JSON+CSV impact log.",
        ].join(" ")
      )
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--rename <pairs...>", "old=new pairs")
      .option("--apply", "Write changes to disk (default is dry-run)")
      .option(
        "--impact-log <path>",
        "Impact log .csv/.json path (sibling pair maintained; overrides NGPILOT_IMPACT_LOG; saved to user config)"
      )
      .addHelpText("after", `\n${CONFIG_HELP}\n`)
  );

  wire("remove", (c) =>
    c
      .description(
        [
          "Remove input/output bindings from HTML templates (dry-run by default).",
          "With --apply: writes files, records a change-run hash, and appends",
          "one impact row per binding change to the JSON+CSV impact log.",
        ].join(" ")
      )
      .option("--selector <name>", "Component selector, e.g. abx-icon")
      .option("--inputs <names...>", "Input property names")
      .option("--outputs <names...>", "Output property names")
      .option("--apply", "Write changes to disk (default is dry-run)")
      .option(
        "--impact-log <path>",
        "Impact log .csv/.json path (sibling pair maintained; overrides NGPILOT_IMPACT_LOG; saved to user config)"
      )
      .addHelpText("after", `\n${CONFIG_HELP}\n`)
  );

  const removeUnusedCmd = addSharedOptions(
    program
      .command("remove-unused")
      .description(
        [
          "Scan @Component @Input/@Output APIs under roots, find unused HTML bindings,",
          "prompt per unused attribute (default No), and on Yes remove templates (--apply)",
          "plus best-effort TypeScript member deletion. Writes a detailed remove-unused log.",
        ].join(" ")
      )
      .option(
        "--impact-log <path>",
        "Impact log .csv/.json path (sibling pair maintained; overrides NGPILOT_IMPACT_LOG; saved to user config)"
      )
      .addHelpText("after", `\n${CONFIG_HELP}\n`)
  );
  removeUnusedCmd.action((options: Record<string, unknown>) => {
    const roots = [
      ...((options.roots as string[]) || []),
      ...((options.root as string[]) || []),
    ];
    partial = {
      command: "remove-unused",
      selector: "",
      inputs: [],
      outputs: [],
      roots,
      interactive: true,
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
      impactLog:
        typeof options.impactLog === "string"
          ? (options.impactLog as string)
          : undefined,
      logsDir:
        typeof options.logsDir === "string"
          ? (options.logsDir as string)
          : undefined,
      runsDir:
        typeof options.runsDir === "string"
          ? (options.runsDir as string)
          : undefined,
    };
  });

  const FIX_IO_HELP = `
Name dictionary:
  Built-in word list ships with the package (used to split names like validchange → validChange).
  Optional user dictionary (plain text, one word per line, # comments allowed):
    --name-dict D:\\path\\my-words.txt
    $env:NGPILOT_NAME_DICT = "D:\\path\\my-words.txt"
  CLI --name-dict and NGPILOT_NAME_DICT are merged with the built-in list.
`.trim();

  const fixIoCmd = addSharedOptions(
    program
      .command("fix-io-names")
      .description(
        [
          "Find @Input/@Output names that violate standards (Outputs must not start with 'on';",
          "names must be camelCase) and interactively rename HTML usages + TypeScript members.",
        ].join(" ")
      )
      .option(
        "--impact-log <path>",
        "Impact log .csv/.json path (sibling pair maintained; overrides NGPILOT_IMPACT_LOG; saved to user config)"
      )
      .option(
        "--name-dict <path>",
        "Extra word list for camelCase segmentation (one word per line; # comments OK). Also: NGPILOT_NAME_DICT"
      )
      .addHelpText("after", `\n${FIX_IO_HELP}\n\n${CONFIG_HELP}\n`)
  );
  fixIoCmd.action((options: Record<string, unknown>) => {
    const roots = [
      ...((options.roots as string[]) || []),
      ...((options.root as string[]) || []),
    ];
    partial = {
      command: "fix-io-names",
      selector: "",
      inputs: [],
      outputs: [],
      roots,
      interactive: true,
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
      impactLog:
        typeof options.impactLog === "string"
          ? (options.impactLog as string)
          : undefined,
      logsDir:
        typeof options.logsDir === "string"
          ? (options.logsDir as string)
          : undefined,
      runsDir:
        typeof options.runsDir === "string"
          ? (options.runsDir as string)
          : undefined,
      nameDict:
        typeof options.nameDict === "string"
          ? (options.nameDict as string)
          : undefined,
    };
  });

  const commitCmd = addSharedOptions(
    program
      .command("commit")
      .description(
        "Create local commits for one or more recorded rename/remove change runs (no push/PR)"
      )
      .argument(
        "[hashes...]",
        "Change run hash id(s) from prior --apply (space-separated)"
      )
      .option(
        "--hash <id>",
        "Change run hash id (alternative/additional to arguments)"
      )
      .option("--branch-name <name>", "Feature branch to create locally")
      .option(
        "--target-branch <name>",
        "Base branch to create the feature branch from"
      )
      .option("--title <text>", "Commit title")
      .option("--body <text>", "Commit description")
      .option("--dry-run", "Prepare locally but skip creating the commit", false)
  );
  commitCmd.action((hashArgs: string[], options: Record<string, unknown>) => {
    const fromArgs = (hashArgs || []).map((h) => String(h).trim()).filter(Boolean);
    const fromOpt =
      typeof options.hash === "string" && options.hash.trim()
        ? [options.hash.trim()]
        : [];
    const commitHashes = [...fromArgs, ...fromOpt];
    partial = {
      command: "commit",
      selector: "",
      inputs: [],
      outputs: [],
      roots: [],
      commitHash: commitHashes[0],
      commitHashes,
      branchName: (options.branchName as string) || undefined,
      targetBranch: (options.targetBranch as string) || undefined,
      commitTitle: (options.title as string) || undefined,
      commitBody: (options.body as string) || undefined,
      commitDryRun: Boolean(options.dryRun),
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
      logsDir:
        typeof options.logsDir === "string"
          ? (options.logsDir as string)
          : undefined,
      runsDir:
        typeof options.runsDir === "string"
          ? (options.runsDir as string)
          : undefined,
    };
  });

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
  const commands = [
    "find",
    "report",
    "rename",
    "remove",
    "remove-unused",
    "fix-io-names",
    "commit",
  ];
  if (!partial.command && commands.includes(argv[0])) {
    partial = { ...partial, command: argv[0] as CommandOptions["command"] };
  }

  const opts = await maybePrompt(partial);
  await runCommand(opts);
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
