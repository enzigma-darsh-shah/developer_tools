/**
 * Integration tests:
 * - applyToolDelta CRLF/LF handling
 * - local commit of a recorded change-run (no push/PR)
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { applyToolDelta } = require("../dist/git/local");
const { runCommitCommand } = require("../dist/commit");
const { saveChangeRun, generateRunHash, RUNS_DIR } = require("../dist/runs");

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

  // Cleanup temp run file + repo.
  try {
    fs.unlinkSync(path.join(RUNS_DIR, `${hash}.json`));
  } catch {
    /* ignore */
  }
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  testApplyToolDeltaNewlines();
  await testLocalCommitFromChangeRun();
  console.log("\nAll local-commit tests passed.");
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
