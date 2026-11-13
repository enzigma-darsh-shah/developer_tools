import * as fs from "fs";
import * as path from "path";
import { getAdapter } from "./git/adapters";
import { parseRemoteUrl } from "./git/detect";
import {
  applyToolDelta,
  currentBranch,
  git,
  gitRemoteUrl,
  pathRelativeToRepo,
  readFileAtRef,
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
  token: string;
  dryRun?: boolean;
}

export interface CommitRepoResult {
  repoName: string;
  repoRoot: string;
  commitSha?: string;
  prUrl?: string;
  error?: string;
}

function resolveToken(explicit?: string): string | undefined {
  if (explicit && explicit.trim()) {
    return explicit.trim();
  }
  const env = process.env.GIT_ACCESS_TOKEN;
  if (env && env.trim()) {
    return env.trim();
  }
  return undefined;
}

export { resolveToken };

/**
 * Prefer HTTPS + token for GitHub (works from CI/desktop without SSH agent).
 * Falls back to embedding the token in an existing HTTPS remote.
 * Leaves non-GitHub SSH remotes unchanged (caller may still fail on 301).
 */
export function resolvePushUrl(remoteUrl: string, token: string): string {
  const parsed = parseRemoteUrl(remoteUrl);
  if (parsed && parsed.kind === "github" && token) {
    return `https://x-access-token:${encodeURIComponent(token)}@github.com/${
      parsed.owner
    }/${parsed.repo}.git`;
  }
  if (/^https?:\/\//i.test(remoteUrl)) {
    return remoteUrl.replace(
      /^(https?:\/\/)/i,
      `$1x-access-token:${encodeURIComponent(token)}@`
    );
  }
  return remoteUrl;
}

function ensureTargetRef(repoRoot: string, targetBranch: string): string {
  const fetch = git(repoRoot, ["fetch", "origin", targetBranch], {
    allowFail: true,
  });
  if (fetch.status !== 0) {
    const detail = `${fetch.stderr}\n${fetch.stdout}`.trim();
    if (/Moved Permanently|HTTP\s*301|\b301\b/i.test(detail)) {
      throw new Error(
        `git fetch failed (Moved Permanently / 301).\n${detail}\n` +
          `Hint: update origin to the current HTTPS URL, e.g.\n` +
          `  git remote set-url origin https://github.com/<owner>/<repo>.git`
      );
    }
    // Continue — local target branch may still exist.
  }

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
  throw new Error(
    `Target branch '${targetBranch}' not found locally or on origin in ${repoRoot}` +
      (fetch.status !== 0
        ? `\nFetch output: ${(fetch.stderr || fetch.stdout).trim()}`
        : "")
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

async function commitOneRepo(
  _run: ChangeRun,
  repo: ChangeRun["repos"][0],
  opts: CommitOptions
): Promise<CommitRepoResult> {
  const repoRoot = repo.repoRoot;
  const previousBranch = currentBranch(repoRoot);
  const previousContents = new Map<string, string | null>();
  let didStash = false;

  for (const file of repo.files) {
    previousContents.set(
      file.absolutePath,
      fs.existsSync(file.absolutePath)
        ? fs.readFileSync(file.absolutePath, "utf8")
        : null
    );
  }

  try {
    // Allow branch switch even when rename --apply left files dirty.
    didStash = stashPush(
      repoRoot,
      `angular-io-tool-commit-${opts.hash}-${Date.now()}`
    );

    const baseRef = ensureTargetRef(repoRoot, opts.targetBranch);

    // Clear staging area.
    git(repoRoot, ["reset", "HEAD"], { allowFail: true });

    // Create / reset feature branch from target (tree is clean after stash).
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

    // Apply only tool hunks onto target-branch file versions.
    for (const file of repo.files) {
      const rel =
        file.relativePath || pathRelativeToRepo(repoRoot, file.absolutePath);
      const baseContent = readFileAtRef(repoRoot, "HEAD", rel);
      if (baseContent === null) {
        fs.mkdirSync(path.dirname(file.absolutePath), { recursive: true });
        fs.writeFileSync(file.absolutePath, file.after, "utf8");
      } else {
        const patched = applyToolDelta(baseContent, file.before, file.after);
        fs.writeFileSync(file.absolutePath, patched, "utf8");
      }
      git(repoRoot, ["add", "--", rel]);
    }

    const staged = git(repoRoot, ["diff", "--cached", "--name-only"], {
      allowFail: true,
    }).stdout.trim();
    if (!staged) {
      throw new Error("Nothing staged after applying tool patches");
    }

    if (opts.dryRun) {
      return {
        repoName: repo.repoName,
        repoRoot,
        commitSha: undefined,
        prUrl: undefined,
        error: "dry-run: skipped commit/push/PR",
      };
    }

    const message = opts.body.trim()
      ? `${opts.title}\n\n${opts.body}`
      : opts.title;
    git(repoRoot, ["commit", "-m", message]);
    const sha = git(repoRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const remoteUrl = repo.remoteUrl || gitRemoteUrl(repoRoot);
    if (!remoteUrl) {
      throw new Error("No origin remote URL — cannot push or open PR");
    }

    const pushUrl = resolvePushUrl(remoteUrl, opts.token);
    try {
      git(repoRoot, [
        "push",
        "-u",
        pushUrl,
        `HEAD:refs/heads/${opts.branchName}`,
        "--force-with-lease",
      ]);
    } catch (pushErr) {
      const msg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      throw new Error(
        `Push failed for ${repo.repoName}.\n${msg}\n` +
          `Remote was: ${remoteUrl}\n` +
          `Push URL host: ${pushUrl.replace(/x-access-token:[^@]+@/i, "x-access-token:***@")}`
      );
    }

    const remote = parseRemoteUrl(remoteUrl);
    if (!remote) {
      throw new Error(`Could not parse remote URL: ${remoteUrl}`);
    }
    const adapter = getAdapter(remote.kind);
    const pr = await adapter.createPullRequest(remote, {
      title: opts.title,
      body: opts.body,
      head: opts.branchName,
      base: opts.targetBranch,
      token: opts.token,
    });

    return {
      repoName: repo.repoName,
      repoRoot,
      commitSha: sha,
      prUrl: pr.url,
    };
  } catch (err) {
    return {
      repoName: repo.repoName,
      repoRoot,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Return to the user's previous branch, then restore dirty worktree.
    try {
      git(repoRoot, ["checkout", "-f", previousBranch], { allowFail: true });
    } catch {
      /* ignore */
    }

    if (didStash) {
      const popped = stashPop(repoRoot);
      if (!popped.ok) {
        // Fall back to the in-memory snapshots of tool-touched files.
        restoreWorktreeFiles(previousContents);
      }
    } else {
      restoreWorktreeFiles(previousContents);
    }
  }
}

export async function runCommitCommand(
  opts: CommitOptions
): Promise<{ run: ChangeRun; results: CommitRepoResult[] }> {
  const token = resolveToken(opts.token);
  if (!token) {
    throw new Error(
      "Git access token required. Set GIT_ACCESS_TOKEN, pass --git-access-token, or enter it interactively."
    );
  }
  const fullOpts = { ...opts, token };

  const run = loadChangeRun(opts.hash);
  if (!run.repos.length) {
    throw new Error(`Run ${run.hash} has no repository changes recorded`);
  }

  const results: CommitRepoResult[] = [];
  for (const repo of run.repos) {
    results.push(await commitOneRepo(run, repo, fullOpts));
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
      prUrl: r.prUrl,
      error: r.error,
    })),
  };
  updateChangeRun(run);

  return { run, results };
}
