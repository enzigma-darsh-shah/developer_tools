import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface RunFileChange {
  absolutePath: string;
  relativePath: string;
  before: string;
  after: string;
}

export interface RunRepoChange {
  repoRoot: string;
  repoName: string;
  remoteUrl: string | null;
  files: RunFileChange[];
}

export interface ChangeRun {
  hash: string;
  createdAt: string;
  command: "rename" | "remove";
  selector: string;
  renameMap?: Record<string, string>;
  inputs: string[];
  outputs: string[];
  roots: string[];
  repos: RunRepoChange[];
  /** Filled after commit command succeeds (partial OK). */
  commit?: {
    branchName: string;
    targetBranch: string;
    title: string;
    body: string;
    results: Array<{
      repoName: string;
      repoRoot: string;
      commitSha?: string;
      prUrl?: string;
      error?: string;
    }>;
  };
}

const TOOL_ROOT = path.resolve(__dirname, "..", "..");
export const RUNS_DIR = path.join(TOOL_ROOT, "logs", "runs");
export const RUNS_INDEX = path.join(RUNS_DIR, "index.json");

export function ensureRunsDir(): void {
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function runPath(hash: string): string {
  return path.join(RUNS_DIR, `${hash}.json`);
}

export function generateRunHash(payload: Omit<ChangeRun, "hash">): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return digest.slice(0, 16);
}

export function saveChangeRun(run: ChangeRun): string {
  ensureRunsDir();
  const file = runPath(run.hash);
  fs.writeFileSync(file, JSON.stringify(run, null, 2), "utf8");

  let index: Array<{ hash: string; createdAt: string; command: string; selector: string }> =
    [];
  if (fs.existsSync(RUNS_INDEX)) {
    try {
      index = JSON.parse(fs.readFileSync(RUNS_INDEX, "utf8"));
    } catch {
      index = [];
    }
  }
  index = index.filter((entry) => entry.hash !== run.hash);
  index.unshift({
    hash: run.hash,
    createdAt: run.createdAt,
    command: run.command,
    selector: run.selector,
  });
  fs.writeFileSync(RUNS_INDEX, JSON.stringify(index, null, 2), "utf8");
  return file;
}

export function loadChangeRun(hash: string): ChangeRun {
  const exact = runPath(hash);
  if (fs.existsSync(exact)) {
    return JSON.parse(fs.readFileSync(exact, "utf8")) as ChangeRun;
  }
  // Allow unique prefix match.
  ensureRunsDir();
  const matches = fs
    .readdirSync(RUNS_DIR)
    .filter((name) => name.startsWith(hash) && name.endsWith(".json"));
  if (matches.length === 1) {
    return JSON.parse(
      fs.readFileSync(path.join(RUNS_DIR, matches[0]), "utf8")
    ) as ChangeRun;
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous run hash prefix '${hash}'. Matches: ${matches
        .map((m) => m.replace(/\.json$/, ""))
        .join(", ")}`
    );
  }
  throw new Error(`No change run found for hash '${hash}'. Look in ${RUNS_DIR}`);
}

export function updateChangeRun(run: ChangeRun): void {
  saveChangeRun(run);
}
