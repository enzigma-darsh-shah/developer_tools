/**
 * Integration tests:
 * - applyToolDelta CRLF/LF handling
 * - local commit of a recorded change-run (no push/PR)
 * - discard tool changes on original branch after success
 * - patch drift → semantic re-apply / after fallback
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { applyToolDelta } = require("../dist/git/local");
const {
  runCommitCommand,
  materializeCommitFileContent,
} = require("../dist/commit");
const { reapplyBindingsToHtml } = require("../dist/bindings_reapply");
const {
  saveChangeRun,
  generateRunHash,
  getRunsDir,
} = require("../dist/runs");

function fail(message) {
  console.error("FAIL:", message);
  process.exit(1);
}

function ok(message) {
  console.log("OK:", message);
}

function run(cwd, args, opts = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    ...opts,
  });
  if (!opts.allowFail && result.status !== 0) {
    fail(`git ${args.join(" ")} failed\n${result.stderr || result.stdout}`);
  }
  return result;
}

function write(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

function testApplyToolDeltaNewlines() {
  const before = 'line\r\n[fillColor]="x"\r\nend\r\n';
  const after = 'line\r\n[foregroundColor]="x"\r\nend\r\n';
  const baseLf = 'line\n[fillColor]="x"\nend\n';
  const patched = applyToolDelta(baseLf, before, after);
  if (!patched.includes("[foregroundColor]")) {
    fail("expected rename to apply across CRLF/LF");
  }
  if (patched.includes("[fillColor]")) {
    fail("expected old binding to be gone");
  }
  if (patched.includes("\r\n")) {
    fail("expected LF output when base is LF");
  }
  ok("applyToolDelta normalizes CRLF/LF correctly");
}

function testReapplyAndMaterializeFallback() {
  const before =
    '<div class="wrap">\n  <abx-icon [fillColor]="\'#000\'"></abx-icon>\n</div>\n';
  const after =
    '<div class="wrap">\n  <abx-icon [foregroundColor]="\'#000\'"></abx-icon>\n</div>\n';
  // Target tip drifted: extra attribute + comment near the binding (breaks naive patch).
  const drifted =
    '<div class="wrap" data-v="2">\n  <!-- header -->\n  <abx-icon size="sm" [fillColor]="\'#000\'"></abx-icon>\n</div>\n';

  const reapplied = reapplyBindingsToHtml(drifted, {
    selector: "abx-icon",
    command: "rename",
    renameMap: { fillColor: "foregroundColor" },
  });
  if (!reapplied || !reapplied.includes("[foregroundColor]")) {
    fail("expected semantic re-apply to rename on drifted HTML");
  }
  if (reapplied.includes("[fillColor]")) {
    fail("expected old binding gone after re-apply");
  }
  if (!reapplied.includes('data-v="2"') || !reapplied.includes("<!-- header -->")) {
    fail("re-apply should preserve unrelated target-tip edits");
  }
  ok("semantic re-apply works on drifted target tip");

  const materialized = materializeCommitFileContent(
    drifted,
    { absolutePath: "x", relativePath: "x", before, after },
    {
      command: "rename",
      selector: "abx-icon",
      renameMap: { fillColor: "foregroundColor" },
      inputs: ["fillColor"],
      outputs: ["fillColor"],
    }
  );
  if (
    materialized.method !== "reapply" &&
    materialized.method !== "patch" &&
    materialized.method !== "fallback-after"
  ) {
    fail(`unexpected materialize method: ${materialized.method}`);
  }
  if (!materialized.content.includes("[foregroundColor]")) {
    fail("materialize should produce renamed binding");
  }
  ok(`materializeCommitFileContent used method=${materialized.method}`);

  const fallback = materializeCommitFileContent(
    '<div>totally unrelated</div>\n',
    { absolutePath: "x", relativePath: "x", before, after },
    {
      command: "rename",
      selector: "abx-icon",
      renameMap: { fillColor: "foregroundColor" },
      inputs: ["fillColor"],
      outputs: ["fillColor"],
    }
  );
  if (fallback.method !== "fallback-after") {
    fail(`expected fallback-after, got ${fallback.method}`);
  }
  if (!fallback.content.includes("[foregroundColor]")) {
    fail("fallback should write after snapshot");
  }
  ok("materialize falls back to after snapshot when re-apply cannot match");
}

async function testLocalCommitFromChangeRun() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aio-commit-"));
  const repo = path.join(root, "demo-repo");
  fs.mkdirSync(repo, { recursive: true });

  run(repo, ["init"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  run(repo, ["config", "user.name", "Test"]);

  const rel = "src/app.component.html";
  const abs = path.join(repo, rel);
  const before = '<abx-icon [fillColor]="\'#000\'"></abx-icon>\n';
  const after = '<abx-icon [foregroundColor]="\'#000\'"></abx-icon>\n';
  write(abs, before);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", "initial"]);
  run(repo, ["branch", "-M", "qa"]);

  // Simulate rename --apply already having modified the worktree.
  write(abs, after);

  const partial = {
    createdAt: new Date().toISOString(),
    command: "rename",
    selector: "abx-icon",
    renameMap: { fillColor: "foregroundColor" },
    inputs: ["fillColor"],
    outputs: ["fillColor"],
    roots: [root],
    repos: [
      {
        repoRoot: repo,
        repoName: "demo-repo",
        remoteUrl: null,
        files: [
          {
            absolutePath: abs,
            relativePath: rel.replace(/\\/g, "/"),
            before,
            after,
          },
        ],
      },
    ],
  };
  const hash = generateRunHash(partial);
  const runRecord = { hash, ...partial };
  saveChangeRun(runRecord);
  ok(`saved change run ${hash}`);

  const { results } = await runCommitCommand({
    hash,
    branchName: "bugfix/rename-fillColor",
    targetBranch: "qa",
    title: "Rename fillColor to foregroundColor",
    body: "local commit test",
  });

  if (results.length !== 1) {
    fail(`expected 1 result, got ${results.length}`);
  }
  if (results[0].error) {
    fail(`local commit failed: ${results[0].error}`);
  }
  if (!results[0].commitSha) {
    fail("expected commitSha");
  }
  if (results[0].branchName !== "bugfix/rename-fillColor") {
    fail(`unexpected branchName ${results[0].branchName}`);
  }
  ok(
    `local commit created on ${results[0].branchName} (${results[0].commitSha.slice(0, 8)})`
  );

  // Feature branch must contain the renamed binding.
  const show = run(repo, [
    "show",
    "bugfix/rename-fillColor:src/app.component.html",
  ]).stdout;
  if (!show.includes("foregroundColor") || show.includes("[fillColor]")) {
    fail(`feature branch content incorrect:\n${show}`);
  }
  ok("feature branch contains tool hunks only (renamed binding)");

  // Current checkout should be restored to previous branch (qa).
  const current = run(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  if (current !== "qa") {
    fail(`expected to restore qa, on ${current}`);
  }
  ok("restored previous branch after local commit");

  // Original branch must NOT keep the applied tool changes dirty/staged.
  const worktree = fs.readFileSync(abs, "utf8");
  if (worktree.includes("[foregroundColor]") || !worktree.includes("[fillColor]")) {
    fail(
      `expected original branch worktree to discard tool changes, got:\n${worktree}`
    );
  }
  const status = run(repo, ["status", "--porcelain"]).stdout.trim();
  if (status) {
    fail(`expected clean worktree on original branch after commit, got:\n${status}`);
  }
  ok("discarded tool changes on original branch after successful commit");

  // Cleanup temp run file + repo.
  try {
    fs.unlinkSync(path.join(getRunsDir(), `${hash}.json`));
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function testCommitWithDriftedTargetUsesReapply() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aio-commit-drift-"));
  const repo = path.join(root, "demo-repo");
  fs.mkdirSync(repo, { recursive: true });

  run(repo, ["init"]);
  run(repo, ["config", "user.email", "test@example.com"]);
  run(repo, ["config", "user.name", "Test"]);

  const rel = "src/app.component.html";
  const abs = path.join(repo, rel);
  const before =
    '<section>\n  <abx-icon [fillColor]="\'#000\'"></abx-icon>\n</section>\n';
  const after =
    '<section>\n  <abx-icon [foregroundColor]="\'#000\'"></abx-icon>\n</section>\n';
  // Commit a drifted qa tip that still has the old binding but different context.
  const driftedQa =
    '<section class="panel">\n  <!-- note -->\n  <abx-icon aria-label="x" [fillColor]="\'#000\'"></abx-icon>\n</section>\n';
  write(abs, driftedQa);
  run(repo, ["add", "."]);
  run(repo, ["commit", "-m", "qa tip drifted"]);
  run(repo, ["branch", "-M", "qa"]);

  // Worktree still has apply-time after (as if rename --apply ran on older before).
  write(abs, after);

  const partial = {
    createdAt: new Date().toISOString(),
    command: "rename",
    selector: "abx-icon",
    renameMap: { fillColor: "foregroundColor" },
    inputs: ["fillColor"],
    outputs: ["fillColor"],
    roots: [root],
    repos: [
      {
        repoRoot: repo,
        repoName: "demo-repo",
        remoteUrl: null,
        files: [
          {
            absolutePath: abs,
            relativePath: rel.replace(/\\/g, "/"),
            before,
            after,
          },
        ],
      },
    ],
  };
  const hash = generateRunHash(partial);
  saveChangeRun({ hash, ...partial });

  const { results } = await runCommitCommand({
    hash,
    branchName: "bugfix/drift-rename",
    targetBranch: "qa",
    title: "Rename despite drift",
    body: "",
  });

  if (results[0].error) {
    fail(`drifted commit failed: ${results[0].error}`);
  }
  const show = run(repo, [
    "show",
    "bugfix/drift-rename:src/app.component.html",
  ]).stdout;
  if (!show.includes("[foregroundColor]") || show.includes("[fillColor]")) {
    fail(`drifted feature branch content incorrect:\n${show}`);
  }
  if (!show.includes('class="panel"') || !show.includes("aria-label")) {
    fail(`expected target-tip context preserved:\n${show}`);
  }
  ok("commit succeeds on drifted target via re-apply/fallback");

  const worktree = fs.readFileSync(abs, "utf8");
  if (worktree.includes("[foregroundColor]")) {
    fail("original branch should not keep renamed binding after success");
  }
  ok("original branch cleaned after drifted commit");

  try {
    fs.unlinkSync(path.join(getRunsDir(), `${hash}.json`));
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  testApplyToolDeltaNewlines();
  testReapplyAndMaterializeFallback();
  await testLocalCommitFromChangeRun();
  await testCommitWithDriftedTargetUsesReapply();
  console.log("\nAll local-commit tests passed.");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
