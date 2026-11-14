import * as fs from "fs";
import * as path from "path";
import { reapplyBindingsToHtml } from "./bindings_reapply";
import {
  applyToolDelta,
  currentBranch,
  detectNewline,
  encodeWithNewline,
  git,
  normalizeNewlines,
  pathRelativeToRepo,
  readFileAtRef,
  restorePathsToHead,
  stashPop,
  stashPush,
} from "./git/local";
import { ChangeRun, loadChangeRun, updateChangeRun } from "./runs";

export interface CommitOptions {
  hash: string;
  branchName: string;
  targetBranch: string;
  title: string;
  body: string;
  dryRun?: boolean;
}

export interface CommitRepoResult {
  repoName: string;
  repoRoot: string;
  branchName: string;
  commitSha?: string;
  error?: string;
  warnings?: string[];
}

/**
 * Resolve a local base ref for branching.
 * Prefers origin/<target> when fetch works; otherwise uses a local branch.
 * Fetch failures (including 301) are non-fatal when a local target exists.
 */
export function ensureTargetRef(repoRoot: string, targetBranch: string): string {
  const fetch = git(repoRoot, ["fetch", "origin", targetBranch], {
    allowFail: true,
  });

  const remoteRef = `origin/${targetBranch}`;
  const hasRemote = git(repoRoot, ["rev-parse", "--verify", remoteRef], {
    allowFail: true,
  });
  if (hasRemote.status === 0) {
    return remoteRef;
  }

  const hasLocal = git(repoRoot, ["rev-parse", "--verify", targetBranch], {
    allowFail: true,
  });
  if (hasLocal.status === 0) {
    return targetBranch;
  }

  const fetchDetail = `${fetch.stderr}\n${fetch.stdout}`.trim();
  throw new Error(
    `Target branch '${targetBranch}' not found locally or on origin in ${repoRoot}` +
      (fetchDetail ? `\nFetch output: ${fetchDetail}` : "")
  );
}

function restoreWorktreeFiles(
  previousContents: Map<string, string | null>
): void {
  for (const [filePath, content] of previousContents) {
    try {
      if (content === null) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } else {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, "utf8");
      }
    } catch {
      /* ignore */
    }
  }
}

export type MaterializeMethod = "exact" | "already" | "patch" | "reapply" | "fallback-after";

/**
 * Build feature-branch file content from the target tip + change-run snapshots.
 * Order: exact/already → unified patch (hardened) → semantic re-apply → write `after`.
 */
export function materializeCommitFileContent(
  baseContent: string | null,
  file: ChangeRun["repos"][0]["files"][0],
  run: Pick<
    ChangeRun,
    "command" | "selector" | "renameMap" | "inputs" | "outputs"
  >
): { content: string; method: MaterializeMethod; warning?: string } {
  const newline = detectNewline(
    baseContent || file.before || file.after
  );

  if (baseContent === null) {
    return {
      content: encodeWithNewline(normalizeNewlines(file.after), newline),
      method: "fallback-after",
      warning:
        "file missing on target branch; wrote apply-time after snapshot",
    };
  }

  const baseN = normalizeNewlines(baseContent);
  const beforeN = normalizeNewlines(file.before);
  const afterN = normalizeNewlines(file.after);

  if (baseN === beforeN) {
    return {
      content: encodeWithNewline(afterN, newline),
      method: "exact",
    };
  }
  if (baseN === afterN) {
    return {
      content: encodeWithNewline(baseN, newline),
      method: "already",
    };
  }

  try {
    return {
      content: applyToolDelta(baseContent, file.before, file.after),
      method: "patch",
    };
  } catch {
    /* try semantic re-apply */
  }

  const reapplied = reapplyBindingsToHtml(baseContent, {
    selector: run.selector,
    command: run.command,
    renameMap: run.renameMap,
    inputs: run.inputs,
    outputs: run.outputs,
  });
  if (reapplied !== null) {
    return {
      content: encodeWithNewline(normalizeNewlines(reapplied), newline),
      method: "reapply",
      warning:
        "unified patch failed; re-applied rename/remove onto target-branch tip",
    };
  }

  return {
    content: encodeWithNewline(afterN, newline),
    method: "fallback-after",
    warning:
      "patch isolation and semantic re-apply failed; wrote apply-time after snapshot (review carefully)",
  };
}

function commitOneRepo(
  repo: ChangeRun["repos"][0],
  opts: CommitOptions,
  run: ChangeRun
): CommitRepoResult {
  const repoRoot = repo.repoRoot;
  const previousBranch = currentBranch(repoRoot);
  const previousContents = new Map<string, string | null>();
  let didStash = false;
  let succeeded = false;
  const warnings: string[] = [];
  const relativePaths: string[] = [];

  for (const file of repo.files) {
    previousContents.set(
      file.absolutePath,
      fs.existsSync(file.absolutePath)
        ? fs.readFileSync(file.absolutePath, "utf8")
        : null
    );
  }

  try {
    didStash = stashPush(
      repoRoot,
      `angular-io-tool-commit-${opts.hash}-${Date.now()}`
    );

    const baseRef = ensureTargetRef(repoRoot, opts.targetBranch);

    git(repoRoot, ["reset", "HEAD"], { allowFail: true });

    const branchExists = git(
      repoRoot,
      ["rev-parse", "--verify", opts.branchName],
      { allowFail: true }
    );
    if (branchExists.status === 0) {
      git(repoRoot, ["checkout", opts.branchName]);
      git(repoRoot, ["reset", "--hard", baseRef]);
    } else {
      git(repoRoot, ["checkout", "-B", opts.branchName, baseRef]);
    }

    git(repoRoot, ["reset", "HEAD"], { allowFail: true });

    let pendingChange = false;
    for (const file of repo.files) {
      const rel =
        file.relativePath || pathRelativeToRepo(repoRoot, file.absolutePath);
      relativePaths.push(rel);
      const baseContent = readFileAtRef(repoRoot, "HEAD", rel);
      const materialized = materializeCommitFileContent(baseContent, file, run);
      if (materialized.warning) {
        warnings.push(`${rel}: ${materialized.warning}`);
      }
      if (materialized.method !== "already") {
        pendingChange = true;
      }
      fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
      fs.writeFileSync(file.absolutePath, materialized.content, "utf8");
      git(repoRoot, ["add", "--", rel]);
    }

    const staged = git(repoRoot, ["diff", "--cached", "--name-only"], {
      allowFail: true,
    }).stdout.trim();
    if (!staged) {
      if (!pendingChange) {
        succeeded = true;
        const sha = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
        warnings.push(
          "target branch already contains these tool changes; nothing new to commit"
        );
        return {
          repoName: repo.repoName,
          repoRoot,
          branchName: opts.branchName,
          commitSha: sha,
          warnings,
        };
      }
      throw new Error(
        "Nothing staged after applying tool patches (target may already contain the changes)"
      );
    }

    if (opts.dryRun) {
      return {
        repoName: repo.repoName,
        repoRoot,
        branchName: opts.branchName,
        error: "dry-run: skipped local commit",
        warnings: warnings.length ? warnings : undefined,
      };
    }

    const message = opts.body.trim()
      ? `${opts.title}\n\n${opts.body}`
      : opts.title;
    git(repoRoot, ["commit", "-m", message]);
    const sha = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();
    succeeded = true;

    return {
      repoName: repo.repoName,
      repoRoot,
      branchName: opts.branchName,
      commitSha: sha,
      warnings: warnings.length ? warnings : undefined,
    };
  } catch (err) {
    return {
      repoName: repo.repoName,
      repoRoot,
      branchName: opts.branchName,
      error: err instanceof Error ? err.message : String(err),
      warnings: warnings.length ? warnings : undefined,
    };
  } finally {
    try {
      git(repoRoot, ["checkout", "-f", previousBranch], { allowFail: true });
    } catch {
      /* ignore */
    }

    if (succeeded) {
      // Restore unrelated local work, then discard only the tool-touched files
      // so the original branch is not left with the same changes staged/dirty.
      if (didStash) {
        const popped = stashPop(repoRoot);
        if (!popped.ok) {
          // Stash could not apply cleanly; leave tip clean for tool files.
        }
      }
      restorePathsToHead(repoRoot, relativePaths);
    } else if (didStash) {
      const popped = stashPop(repoRoot);
      if (!popped.ok) {
        restoreWorktreeFiles(previousContents);
      }
    } else {
      restoreWorktreeFiles(previousContents);
    }
  }
}

/**
 * Create/reset local feature branches and commit tool hunks only.
 * Does not push or open PRs — no GIT_ACCESS_TOKEN required.
 */
export async function runCommitCommand(
  opts: CommitOptions
): Promise<{ run: ChangeRun; results: CommitRepoResult[] }> {
  const run = loadChangeRun(opts.hash);
  if (!run.repos.length) {
    throw new Error(`Run ${run.hash} has no repository changes recorded`);
  }

  const results: CommitRepoResult[] = [];
  for (const repo of run.repos) {
    results.push(commitOneRepo(repo, opts, run));
  }

  run.commit = {
    branchName: opts.branchName,
    targetBranch: opts.targetBranch,
    title: opts.title,
    body: opts.body,
    results: results.map((r) => ({
      repoName: r.repoName,
      repoRoot: r.repoRoot,
      commitSha: r.commitSha,
      error: r.error,
    })),
  };
  updateChangeRun(run);

  return { run, results };
}
