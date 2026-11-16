import * as fs from "fs";
import * as path from "path";
import { IoKind } from "./component_io";

export type NamingRuleId = "output-no-on-prefix" | "camel-case";

export interface NamingViolation {
  ruleId: NamingRuleId;
  message: string;
}

export interface NamingSuggestion {
  original: string;
  suggested: string;
  violations: NamingViolation[];
  /** Segmentation used for suggestion (debug / log). */
  segments?: string[];
}

const BUILTIN_FALLBACK_WORDS = [
  "valid",
  "change",
  "click",
  "icon",
  "color",
  "value",
  "index",
  "form",
  "input",
  "output",
  "custom",
  "utility",
  "action",
  "select",
  "selected",
  "enable",
  "enabled",
  "disable",
  "disabled",
  "visible",
  "hidden",
  "open",
  "close",
  "show",
  "hide",
  "load",
  "loading",
  "error",
  "success",
  "warning",
  "message",
  "title",
  "label",
  "name",
  "type",
  "size",
  "width",
  "height",
  "data",
  "item",
  "items",
  "list",
  "row",
  "column",
  "table",
  "page",
  "modal",
  "dialog",
  "button",
  "text",
  "number",
  "string",
  "boolean",
  "true",
  "false",
  "null",
  "event",
  "handler",
  "callback",
  "config",
  "option",
  "options",
  "status",
  "state",
  "model",
  "view",
  "panel",
  "header",
  "footer",
  "content",
  "active",
  "focus",
  "hover",
  "press",
  "drag",
  "drop",
  "start",
  "end",
  "min",
  "max",
  "total",
  "count",
  "index",
  "key",
  "id",
  "url",
  "html",
  "css",
  "api",
  "http",
  "json",
  "xml",
  "src",
  "alt",
  "aria",
  "role",
  "tab",
  "nav",
  "menu",
  "user",
  "group",
  "file",
  "path",
  "date",
  "time",
  "year",
  "day",
  "month",
  "primary",
  "secondary",
  "default",
  "required",
  "readonly",
  "placeholder",
  "search",
  "filter",
  "sort",
  "order",
  "asc",
  "desc",
  "prev",
  "next",
  "first",
  "last",
  "current",
  "selected",
  "checked",
  "expand",
  "collapse",
  "toggle",
  "update",
  "create",
  "delete",
  "remove",
  "add",
  "edit",
  "save",
  "cancel",
  "submit",
  "reset",
  "clear",
  "refresh",
  "reload",
  "fetch",
  "request",
  "response",
  "result",
  "error",
  "valid",
  "invalid",
  "complete",
  "progress",
  "pending",
  "ready",
  "idle",
  "busy",
  "open",
  "closed",
  "left",
  "right",
  "top",
  "bottom",
  "center",
  "middle",
  "small",
  "large",
  "medium",
  "full",
  "empty",
  "new",
  "old",
  "temp",
  "tmp",
  "main",
  "side",
  "inner",
  "outer",
  "parent",
  "child",
  "children",
  "root",
  "base",
  "core",
  "util",
  "utility",
  "helper",
  "service",
  "store",
  "state",
  "signal",
  "stream",
  "subject",
  "observe",
  "emit",
  "bind",
  "bound",
  "map",
  "set",
  "get",
  "has",
  "is",
  "can",
  "should",
  "with",
  "without",
  "from",
  "to",
  "by",
  "of",
  "and",
  "or",
  "not",
  "all",
  "any",
  "some",
  "none",
  "one",
  "two",
  "multi",
  "single",
  "double",
  "triple",
];

let cachedWords: Set<string> | null = null;
let cachedExtraPaths: string[] = [];

function builtinWordFileCandidates(): string[] {
  // dist/data (after copy-data) and ../data next to package
  return [
    path.join(__dirname, "data", "name-words.txt"),
    path.join(__dirname, "..", "data", "name-words.txt"),
  ];
}

export function loadWordListFromFile(filePath: string): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const words: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    words.push(trimmed.toLowerCase());
  }
  return words;
}

/**
 * Load built-in + optional user dictionaries.
 * User paths: explicit files and/or NGPILOT_NAME_DICT.
 */
export function getNameDictionary(extraFiles: string[] = []): Set<string> {
  const normalizedExtras = extraFiles
    .map((p) => path.resolve(p))
    .filter(Boolean)
    .sort();
  const sameExtras =
    cachedWords &&
    cachedExtraPaths.length === normalizedExtras.length &&
    cachedExtraPaths.every((p, i) => p === normalizedExtras[i]);
  if (sameExtras && cachedWords) {
    return cachedWords;
  }

  const words = new Set<string>(BUILTIN_FALLBACK_WORDS);
  for (const candidate of builtinWordFileCandidates()) {
    if (fs.existsSync(candidate)) {
      for (const w of loadWordListFromFile(candidate)) {
        words.add(w);
      }
      break;
    }
  }

  const envPath = process.env.NGPILOT_NAME_DICT?.trim();
  const allExtras = [
    ...(envPath ? [envPath] : []),
    ...normalizedExtras,
  ];
  for (const file of allExtras) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Name dictionary file not found: ${resolved}`);
    }
    for (const w of loadWordListFromFile(resolved)) {
      words.add(w);
    }
  }

  cachedWords = words;
  cachedExtraPaths = normalizedExtras;
  return words;
}

/** Reset dictionary cache (tests). */
export function resetNameDictionaryCache(): void {
  cachedWords = null;
  cachedExtraPaths = [];
}

export function isValidJsIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/**
 * True when name is acceptable camelCase:
 * - valid identifier starting with lowercase
 * - either a single dictionary word, or contains an uppercase letter (multi-word camelCase)
 * - no _ or -
 */
export function isProperCamelCase(name: string, dict: Set<string>): boolean {
  if (!name || !isValidJsIdentifier(name)) {
    return false;
  }
  if (/[_-]/.test(name)) {
    return false;
  }
  if (name[0] < "a" || name[0] > "z") {
    return false;
  }
  if (/[A-Z]/.test(name)) {
    return true;
  }
  // all lowercase: OK only if whole token is a known word (or very short)
  const lower = name.toLowerCase();
  if (dict.has(lower)) {
    return true;
  }
  if (lower.length <= 3) {
    return true;
  }
  // If it segments into multiple words, it should have been camelCased
  const parts = segmentWords(lower, dict);
  return parts.length <= 1;
}

/**
 * Greedy longest-match word segmentation left-to-right, with backtracking
 * for short leftovers.
 */
export function segmentWords(text: string, dict: Set<string>): string[] {
  const s = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!s) {
    return [];
  }
  const memo = new Map<number, string[] | null>();

  function dfs(i: number): string[] | null {
    if (i >= s.length) {
      return [];
    }
    if (memo.has(i)) {
      return memo.get(i)!;
    }
    let best: string[] | null = null;
    for (let j = s.length; j > i; j--) {
      const piece = s.slice(i, j);
      const known =
        dict.has(piece) ||
        (piece.length <= 2 && /^[a-z]+$/.test(piece)) ||
        /^\d+$/.test(piece);
      if (!known) {
        continue;
      }
      const rest = dfs(j);
      if (rest) {
        const candidate = [piece, ...rest];
        if (
          !best ||
          candidate.length < best.length ||
          (candidate.length === best.length &&
            candidate.join("").length >= best.join("").length)
        ) {
          // Prefer fewer longer words
          if (
            !best ||
            candidate.length < best.length ||
            averageLen(candidate) > averageLen(best)
          ) {
            best = candidate;
          }
        }
      }
    }
    memo.set(i, best);
    return best;
  }

  return dfs(0) || [s];
}

function averageLen(parts: string[]): number {
  if (!parts.length) {
    return 0;
  }
  return parts.reduce((n, p) => n + p.length, 0) / parts.length;
}

export function toCamelCaseFromParts(parts: string[]): string {
  if (!parts.length) {
    return "";
  }
  const [first, ...rest] = parts;
  return (
    first.toLowerCase() +
    rest
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join("")
  );
}

/** Split existing camel/Pascal/snake/kebab into word parts. */
export function splitIdentifierParts(name: string): string[] {
  const withSeps = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim();
  return withSeps
    .split(/\s+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

export function suggestCamelName(raw: string, dict: Set<string>): {
  suggested: string;
  segments: string[];
} {
  let working = raw.trim();
  // Strip leading on (case-insensitive) for suggestion helpers
  if (/^on/i.test(working) && working.length > 2) {
    working = working.slice(2);
  }
  let parts = splitIdentifierParts(working);
  if (parts.length === 1 && !/[A-Z]/.test(working) && !/[_-]/.test(raw)) {
    parts = segmentWords(parts[0], dict);
  }
  // Re-segment tiny leftovers if possible
  const expanded: string[] = [];
  for (const part of parts) {
    if (part.length >= 6 && !dict.has(part)) {
      const sub = segmentWords(part, dict);
      expanded.push(...sub);
    } else {
      expanded.push(part);
    }
  }
  const suggested = toCamelCaseFromParts(expanded.filter(Boolean));
  return {
    suggested: isValidJsIdentifier(suggested) ? suggested : raw,
    segments: expanded,
  };
}

export function analyzePublicName(
  publicName: string,
  kind: IoKind,
  dict: Set<string>
): NamingSuggestion | null {
  const violations: NamingViolation[] = [];
  let working = publicName;

  if (kind === "output" && /^on/i.test(publicName)) {
    violations.push({
      ruleId: "output-no-on-prefix",
      message: `Output '${publicName}' should not start with 'on'`,
    });
  }

  if (!isProperCamelCase(publicName, dict)) {
    // After stripping on for camel check on outputs that only fail due to on+Pascal?
    const withoutOn =
      kind === "output" && /^on/i.test(publicName)
        ? publicName.slice(2)
        : publicName;
    if (
      !isProperCamelCase(publicName, dict) ||
      (withoutOn && !isProperCamelCase(withoutOn, dict))
    ) {
      violations.push({
        ruleId: "camel-case",
        message: `'${publicName}' is not proper camelCase`,
      });
    }
  }

  // If only violation is on-prefix but remainder is already camelCase, still suggest strip
  if (!violations.length) {
    return null;
  }

  const { suggested, segments } = suggestCamelName(working, dict);
  let finalSuggested = suggested;
  if (!finalSuggested || finalSuggested === publicName) {
    // Force strip on even if suggest returned same
    if (kind === "output" && /^on/i.test(publicName)) {
      const stripped = publicName.slice(2);
      finalSuggested =
        suggestCamelName(stripped, dict).suggested ||
        stripped.charAt(0).toLowerCase() + stripped.slice(1);
    }
  }
  if (!isValidJsIdentifier(finalSuggested)) {
    finalSuggested = publicName;
  }

  return {
    original: publicName,
    suggested: finalSuggested,
    violations,
    segments,
  };
}

export function formatViolations(v: NamingViolation[]): string {
  return v.map((x) => x.ruleId).join(", ");
}
