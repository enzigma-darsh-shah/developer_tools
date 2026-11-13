import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";

export function git(
  repoRoot: string,
  args: string[],
  opts: { input?: string; allowFail?: boolean } = {}
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = result.status ?? 1;
  if (!opts.allowFail && status !== 0) {
    const message =
      (result.stderr || result.stdout || "").trim() ||
      `git ${args.join(" ")} failed (${status})`;
    throw new Error(enrichGitError(message, args));
  }
  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status,
  };
}

function enrichGitError(message: string, args: string[]): string {
  if (/Moved Permanently|HTTP\s*301|\b301\b/i.test(message)) {
    return (
      `${message}\n` +
      `Hint: the remote likely redirected (renamed org/repo or HTTP→HTTPS). ` +
      `Check with \`git remote -v\` and update origin, e.g.\n` +
      `  git remote set-url origin https://github.com/<owner>/<repo>.git\n` +
      `(git ${args.join(" ")})`
    );
  }
  return message;
}

export function gitTopLevel(dir: string): string | null {
  try {
    const result = git(dir, ["rev-parse", "--show-toplevel"], { allowFail: true });
    if (result.status !== 0) {
      return null;
    }
    return path.resolve(result.stdout.trim());
  } catch {
    return null;
  }
}

export function gitRemoteUrl(repoRoot: string): string | null {
  const result = git(repoRoot, ["remote", "get-url", "origin"], {
    allowFail: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim() || null;
}

export function currentBranch(repoRoot: string): string {
  return git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function detectNewline(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function encodeWithNewline(text: string, newline: "\r\n" | "\n"): string {
  const normalized = normalizeNewlines(text);
  if (newline === "\n") {
    return normalized;
  }
  return normalized.replace(/\n/g, "\r\n");
}

/**
 * Apply the tool's before→after delta onto a base file (usually target-branch tip).
 * Newlines are normalized for matching; output preserves the base file's newline style.
 */
export function applyToolDelta(
  base: string,
  before: string,
  after: string
): string {
  const newline = detectNewline(base || before || after);
  const baseN = normalizeNewlines(base);
  const beforeN = normalizeNewlines(before);
  const afterN = normalizeNewlines(after);

  if (baseN === beforeN) {
    return encodeWithNewline(afterN, newline);
  }
  // Tool changes already present on target tip.
  if (baseN === afterN) {
    return encodeWithNewline(baseN, newline);
  }

  const patchText = createTwoFilesPatch(
    "before",
    "after",
    beforeN,
    afterN,
    "",
    "",
    { context: 3 }
  );
  const patches = parsePatch(patchText);
  if (!patches.length) {
    throw new Error("Could not compute a patch between before/after contents");
  }

  let patched = applyPatch(baseN, patches[0], { fuzzFactor: 2 });
  if (patched === false) {
    // Retry with more fuzz for minor context drift.
    patched = applyPatch(baseN, patches[0], { fuzzFactor: 5 });
  }
  if (patched === false) {
    throw new Error(
      "Patch isolation failed: the target-branch file no longer matches the " +
        "pre-change snapshot closely enough to apply only the tool hunks " +
        "(after newline normalization). Rebase/update and re-run rename/remove, " +
        "or resolve manually."
    );
  }
  return encodeWithNewline(patched, newline);
}

export function readFileAtRef(
  repoRoot: string,
  ref: string,
  relativePath: string
): string | null {
  const result = git(repoRoot, ["show", `${ref}:${relativePath.replace(/\\/g, "/")}`], {
    allowFail: true,
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout;
}

export function pathRelativeToRepo(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).replace(/\\/g, "/");
}

export function ensureDirFor(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

/** Stash local changes so branch switches can proceed. Returns true if a stash entry was created. */
export function stashPush(repoRoot: string, message: string): boolean {
  const result = git(
    repoRoot,
    ["stash", "push", "-u", "-m", message],
    { allowFail: true }
  );
  const text = `${result.stdout}\n${result.stderr}`;
  if (/No local changes to save/i.test(text)) {
    return false;
  }
  return result.status === 0;
}

export function stashPop(repoRoot: string): { ok: boolean; message: string } {
  const result = git(repoRoot, ["stash", "pop"], { allowFail: true });
  const message = `${result.stdout}\n${result.stderr}`.trim();
  return { ok: result.status === 0, message };
}
