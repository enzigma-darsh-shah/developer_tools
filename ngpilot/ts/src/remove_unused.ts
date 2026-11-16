import * as fs from "fs";
import * as path from "path";
import {
  applyIoMemberRemoval,
  IoKind,
  IoMember,
  listTsFilesUnderRoots,
  parseComponentFile,
  ParsedComponentFile,
} from "./component_io";
import { ensureDir, resolveImpactLogPaths, resolveLogsDir } from "./paths";
import { getChangeRunPath } from "./runs";

export type UnusedDecision = "yes" | "no" | "nc" | "nr" | "q";

export interface UsageHitLike {
  filePath: string;
  repo: string;
  bindings: Array<{ propertyName: string; line: number }>;
}

export interface AttributeUsageStats {
  kind: IoKind;
  publicName: string;
  propertyName: string;
  bindingHits: number;
  tagCount: number;
  fileCount: number;
  repoCount: number;
  repos: string[];
  files: string[];
  /** Set when user skipped this unused attr via N/NC/NR. */
  skipAction?: "n" | "nc" | "nr";
  /** Set when user removed this unused attr. */
  removed?: boolean;
}

export interface ComponentScanRecord {
  repoName: string;
  repoRoot: string;
  filePath: string;
  className: string;
  selector: string;
  attributes: AttributeUsageStats[];
  skipped: boolean;
  skipReason?: string;
}

export interface RemovedAttributeRecord {
  repoName: string;
  className: string;
  selector: string;
  kind: IoKind;
  publicName: string;
  propertyName: string;
  changeRunHash?: string;
  tsRemovalFailed?: boolean;
  tsError?: string;
}

export interface StoppedAt {
  timestamp: string;
  repoName?: string;
  className?: string;
  selector?: string;
  attribute?: string;
  reason: "completed" | "quit";
}

export interface ChangeRunHashInfo {
  hash: string;
  runFile: string;
}

export interface RemoveUnusedSummary {
  componentsScanned: number;
  componentsSkipped: number;
  attributesChecked: number;
  unusedFound: number;
  removed: number;
  skippedByUser: number;
  skippedViaNc: number;
  skippedViaNr: number;
  quitMidRun: boolean;
  tsRemovalWarnings: number;
  affectedRepos: string[];
  changeRunHashes: string[];
  changeRunHashInfos: ChangeRunHashInfo[];
  removedAttributes: RemovedAttributeRecord[];
  stoppedAt: StoppedAt;
  logPath: string;
  impactJsonPath?: string;
  impactCsvPath?: string;
  transcriptLogPath?: string;
}

export interface RemoveUnusedDeps {
  skipDirNames: Set<string>;
  collectUsages: (
    selector: string,
    roots: string[],
    inputs: string[],
    outputs: string[]
  ) => UsageHitLike[];
  removeHtmlApply: (args: {
    selector: string;
    roots: string[];
    inputs: string[];
    outputs: string[];
    impactLog?: string;
  }) => Promise<{ repos: string[]; runHash?: string; files: string[] }>;
  promptText: (
    message: string,
    opts?: { required?: boolean; defaultValue?: string }
  ) => Promise<string>;
  /** Prompt for unused-attribute decision. Must not exit the process on q. */
  promptUnusedDecision: (message: string) => Promise<UnusedDecision>;
  log?: string;
  impactLog?: string;
  onProgress?: (message: string) => void;
}

function countStatsForMembers(
  members: IoMember[],
  usages: UsageHitLike[]
): AttributeUsageStats[] {
  const stats: AttributeUsageStats[] = [];
  for (const member of members) {
    const hits = usages.flatMap((u) =>
      u.bindings
        .filter((b) => b.propertyName === member.publicName)
        .map((b) => ({ usage: u, binding: b }))
    );
    const files = [...new Set(hits.map((h) => h.usage.filePath))];
    const repos = [...new Set(hits.map((h) => h.usage.repo))];
    const tags = new Set(
      hits.map((h) => `${h.usage.filePath}:${h.binding.line}`)
    );
    stats.push({
      kind: member.kind,
      publicName: member.publicName,
      propertyName: member.propertyName,
      bindingHits: hits.length,
      tagCount: tags.size,
      fileCount: files.length,
      repoCount: repos.length,
      repos,
      files,
    });
  }
  return stats;
}

function defaultRemoveUnusedLogPath(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const dir = resolveLogsDir().dir;
  ensureDir(dir);
  return path.join(dir, `remove-unused-${stamp}.log`);
}

export function printRemoveUnusedControlsHelp(): void {
  console.log("Unused-attribute controls (shown once):");
  console.log("  Y   Remove this unused attribute (HTML --apply + TS best-effort)");
  console.log("  N   Skip this attribute only (default)");
  console.log("  NC  Skip remaining unused attributes on this component");
  console.log("  NR  Skip remaining unused attributes in this repository");
  console.log("  Q   Quit remove-unused (writes log + prints summary)");
  console.log();
}

export function formatRemoveUnusedLog(
  records: ComponentScanRecord[],
  summary: Omit<RemoveUnusedSummary, "logPath" | "transcriptLogPath">
): string {
  const lines: string[] = [];
  lines.push("ngpilot remove-unused report");
  lines.push(`generatedAt: ${new Date().toISOString()}`);
  lines.push(`quitMidRun: ${summary.quitMidRun}`);
  lines.push(
    `stoppedAt: ${summary.stoppedAt.timestamp}` +
      (summary.stoppedAt.repoName
        ? ` | repo=${summary.stoppedAt.repoName}`
        : "") +
      (summary.stoppedAt.className
        ? ` | class=${summary.stoppedAt.className}`
        : "") +
      (summary.stoppedAt.selector
        ? ` | selector=${summary.stoppedAt.selector}`
        : "") +
      (summary.stoppedAt.attribute
        ? ` | attribute=${summary.stoppedAt.attribute}`
        : "") +
      ` | reason=${summary.stoppedAt.reason}`
  );
  lines.push("");
  lines.push("## Summary");
  lines.push(`componentsScanned: ${summary.componentsScanned}`);
  lines.push(`componentsSkipped: ${summary.componentsSkipped}`);
  lines.push(`attributesChecked: ${summary.attributesChecked}`);
  lines.push(`unusedFound: ${summary.unusedFound}`);
  lines.push(`removed: ${summary.removed}`);
  lines.push(`skippedByUser (N): ${summary.skippedByUser}`);
  lines.push(`skippedViaNc: ${summary.skippedViaNc}`);
  lines.push(`skippedViaNr: ${summary.skippedViaNr}`);
  lines.push(`tsRemovalWarnings: ${summary.tsRemovalWarnings}`);
  lines.push(
    `affectedRepos: ${summary.affectedRepos.join(", ") || "(none)"}`
  );
  lines.push(
    `changeRunHashes: ${summary.changeRunHashes.join(" ") || "(none)"}`
  );
  if (summary.impactJsonPath || summary.impactCsvPath) {
    lines.push(`impactJson: ${summary.impactJsonPath || "(none)"}`);
    lines.push(`impactCsv: ${summary.impactCsvPath || "(none)"}`);
  }
  lines.push("");

  if (summary.removedAttributes.length) {
    lines.push("## Removed attributes");
    for (const item of summary.removedAttributes) {
      lines.push(
        `  - ${item.repoName} <${item.selector}> ${item.kind} ${item.publicName}` +
          (item.changeRunHash ? ` hash=${item.changeRunHash}` : "") +
          (item.tsRemovalFailed ? ` TS_FAIL=${item.tsError || "yes"}` : "")
      );
    }
    lines.push("");
  }

  if (summary.changeRunHashInfos.length) {
    lines.push("## Change-run files");
    for (const info of summary.changeRunHashInfos) {
      lines.push(`  - ${info.hash}`);
      lines.push(`    ${info.runFile}`);
    }
    lines.push("");
  }

  const byRepo = new Map<string, ComponentScanRecord[]>();
  for (const record of records) {
    const list = byRepo.get(record.repoName) || [];
    list.push(record);
    byRepo.set(record.repoName, list);
  }

  for (const repoName of [...byRepo.keys()].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  )) {
    lines.push(`## Repo: ${repoName}`);
    for (const record of byRepo.get(repoName)!) {
      lines.push("");
      lines.push(`### ${record.className}  <${record.selector}>`);
      lines.push(`file: ${record.filePath}`);
      if (record.skipped) {
        lines.push(`skipped: ${record.skipReason || "yes"}`);
        continue;
      }
      if (!record.attributes.length) {
        lines.push("attributes: (none parsed)");
        continue;
      }
      lines.push("attributes:");
      for (const attr of record.attributes) {
        const flags: string[] = [];
        if (attr.bindingHits === 0) {
          flags.push("UNUSED");
        }
        if (attr.removed) {
          flags.push("REMOVED");
        }
        if (attr.skipAction) {
          flags.push(`SKIP_${attr.skipAction.toUpperCase()}`);
        }
        lines.push(
          `  - ${attr.kind} ${attr.publicName}` +
            (attr.propertyName && attr.propertyName !== attr.publicName
              ? ` (ts: ${attr.propertyName})`
              : "") +
            ` | bindings=${attr.bindingHits}` +
            ` tags=${attr.tagCount}` +
            ` files=${attr.fileCount}` +
            ` repos=${attr.repoCount}` +
            (flags.length ? ` | ${flags.join(",")}` : "")
        );
        if (attr.files.length) {
          for (const file of attr.files.slice(0, 20)) {
            lines.push(`      file: ${file}`);
          }
          if (attr.files.length > 20) {
            lines.push(`      ... ${attr.files.length - 20} more files`);
          }
        }
      }
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function printRemoveUnusedSummary(summary: RemoveUnusedSummary): void {
  console.log();
  console.log(
    summary.quitMidRun
      ? "remove-unused stopped (quit)"
      : "remove-unused complete"
  );
  console.log();
  console.log("Counts:");
  console.log(`  Components scanned:     ${summary.componentsScanned}`);
  console.log(`  Components skipped:     ${summary.componentsSkipped}`);
  console.log(`  Attributes checked:     ${summary.attributesChecked}`);
  console.log(`  Unused found:           ${summary.unusedFound}`);
  console.log(`  Removed:                ${summary.removed}`);
  console.log(`  Skipped (N):            ${summary.skippedByUser}`);
  console.log(`  Skipped via NC:         ${summary.skippedViaNc}`);
  console.log(`  Skipped via NR:         ${summary.skippedViaNr}`);
  console.log(`  Quit mid-run:           ${summary.quitMidRun ? "yes" : "no"}`);
  console.log(`  TS removal warnings:    ${summary.tsRemovalWarnings}`);
  if (summary.removed > 0) {
    console.log(
      `  Removed attribute list: see detail log (${summary.removed} entr${
        summary.removed === 1 ? "y" : "ies"
      })`
    );
  }

  console.log();
  console.log("Stopped at:");
  console.log(`  Timestamp: ${summary.stoppedAt.timestamp}`);
  console.log(`  Reason:    ${summary.stoppedAt.reason}`);
  if (summary.stoppedAt.repoName) {
    console.log(`  Repo:      ${summary.stoppedAt.repoName}`);
  }
  if (summary.stoppedAt.className) {
    console.log(`  Class:     ${summary.stoppedAt.className}`);
  }
  if (summary.stoppedAt.selector) {
    console.log(`  Selector:  <${summary.stoppedAt.selector}>`);
  }
  if (summary.stoppedAt.attribute) {
    console.log(`  Attribute: ${summary.stoppedAt.attribute}`);
  }

  console.log();
  console.log("Change-run hashes:");
  if (!summary.changeRunHashInfos.length) {
    console.log("  (none)");
  } else {
    for (const info of summary.changeRunHashInfos) {
      console.log(`  ${info.hash}`);
      console.log(`    ${info.runFile}`);
    }
    console.log();
    console.log(summary.changeRunHashes.join(" "));
  }

  console.log();
  console.log("Affected repositories:");
  if (!summary.affectedRepos.length) {
    console.log("  (none)");
  } else {
    for (const repo of summary.affectedRepos) {
      console.log(`  ${repo}`);
    }
  }

  console.log();
  console.log("Log files:");
  console.log(`  Detail log: ${summary.logPath}`);
  if (summary.transcriptLogPath) {
    console.log(`  Transcript: ${summary.transcriptLogPath}`);
  }

  if (summary.impactJsonPath || summary.impactCsvPath) {
    console.log();
    console.log("Impact area logs updated:");
    if (summary.impactJsonPath) {
      console.log(`  JSON: ${summary.impactJsonPath}`);
    }
    if (summary.impactCsvPath) {
      console.log(`  CSV:  ${summary.impactCsvPath}`);
    }
  }

  if (summary.tsRemovalWarnings > 0) {
    console.log();
    console.log(
      `Warning: ${summary.tsRemovalWarnings} TypeScript @Input/@Output removal(s) failed.`
    );
    console.log(
      "Remove those members manually in the component files if still present (see detail log)."
    );
  }

  if (summary.changeRunHashes.length) {
    console.log();
    console.log("Suggested next command:");
    console.log(
      `  ngpilot commit ${summary.changeRunHashes.join(
        " "
      )} --branch-name <name> --target-branch <base> --title "<msg>"`
    );
  }
}

/**
 * Interactive remove-unused workflow.
 * Prompts inline for unknown selectors/attribute names; prompts only for unused attrs.
 */
export async function runRemoveUnused(
  roots: string[],
  deps: RemoveUnusedDeps
): Promise<RemoveUnusedSummary> {
  const records: ComponentScanRecord[] = [];
  const affectedRepos = new Set<string>();
  const changeRunHashes: string[] = [];
  const changeRunHashInfos: ChangeRunHashInfo[] = [];
  const removedAttributes: RemovedAttributeRecord[] = [];
  let componentsScanned = 0;
  let componentsSkipped = 0;
  let attributesChecked = 0;
  let unusedFound = 0;
  let removed = 0;
  let skippedByUser = 0;
  let skippedViaNc = 0;
  let skippedViaNr = 0;
  let tsRemovalWarnings = 0;
  let quitMidRun = false;
  let impactTouched = false;

  let lastRepo = "";
  let lastClass = "";
  let lastSelector = "";
  let lastAttribute = "";

  const progress = deps.onProgress || (() => undefined);
  printRemoveUnusedControlsHelp();

  const tsFiles = listTsFilesUnderRoots(roots, deps.skipDirNames);
  progress(`Scanning ${tsFiles.length} TypeScript file(s) for @Component…`);

  const parsedFiles: ParsedComponentFile[] = [];
  for (const file of tsFiles) {
    const parsed = parseComponentFile(file, roots);
    if (parsed) {
      parsedFiles.push(parsed);
    }
  }
  parsedFiles.sort((a, b) => {
    const repoCmp = a.repoName
      .toLowerCase()
      .localeCompare(b.repoName.toLowerCase());
    if (repoCmp !== 0) {
      return repoCmp;
    }
    return a.filePath.toLowerCase().localeCompare(b.filePath.toLowerCase());
  });

  let currentRepo = "";
  let skipRestOfRepo = false;
  let skipRestOfComponent = false;

  outer: for (const parsed of parsedFiles) {
    if (parsed.repoName !== currentRepo) {
      currentRepo = parsed.repoName;
      skipRestOfRepo = false;
      skipRestOfComponent = false;
      progress(`\nRepo: ${currentRepo}`);
    }

    if (skipRestOfRepo) {
      // Still record later components lightly? User asked to skip attributes of
      // remaining components in repo — we skip prompts/deletes but can skip
      // scanning to save time, marking as skipped via NR.
      componentsScanned += 1;
      componentsSkipped += 1;
      records.push({
        repoName: parsed.repoName,
        repoRoot: parsed.repoRoot,
        filePath: parsed.filePath,
        className: parsed.className,
        selector: parsed.selector || "(unresolved)",
        attributes: [],
        skipped: true,
        skipReason: "skipped via NR (rest of repository)",
      });
      continue;
    }

    componentsScanned += 1;
    lastRepo = parsed.repoName;
    lastClass = parsed.className;
    skipRestOfComponent = false;

    let selector = parsed.selector;
    if (!selector) {
      const answered = (
        await deps.promptText(
          `Selector unknown for ${parsed.className} (${parsed.filePath}). Enter selector (Enter = skip component)`,
          { required: false }
        )
      ).trim();
      if (!answered) {
        componentsSkipped += 1;
        records.push({
          repoName: parsed.repoName,
          repoRoot: parsed.repoRoot,
          filePath: parsed.filePath,
          className: parsed.className,
          selector: "(unknown)",
          attributes: [],
          skipped: true,
          skipReason: "user skipped unknown selector",
        });
        continue;
      }
      if (answered.toLowerCase() === "q") {
        quitMidRun = true;
        break outer;
      }
      selector = answered.replace(/^<|>$/g, "").trim();
    }
    lastSelector = selector;

    const resolvedMembers: IoMember[] = [];
    for (const member of parsed.members) {
      let publicName = member.publicName;
      let propertyName = member.propertyName;
      if (member.needsNamePrompt || !publicName) {
        const answered = (
          await deps.promptText(
            `Could not parse ${member.kind} name in ${parsed.className}` +
              (member.rawSnippet
                ? `\n  ${member.rawSnippet.split("\n")[0]}`
                : "") +
              `\nEnter public attribute name for find/remove (Enter = skip)`,
            { required: false }
          )
        ).trim();
        if (!answered) {
          continue;
        }
        if (answered.toLowerCase() === "q") {
          quitMidRun = true;
          break outer;
        }
        publicName = answered;
        if (!propertyName) {
          propertyName = answered;
        }
      }
      resolvedMembers.push({
        ...member,
        publicName,
        propertyName,
        needsNamePrompt: false,
      });
    }

    if (!resolvedMembers.length) {
      records.push({
        repoName: parsed.repoName,
        repoRoot: parsed.repoRoot,
        filePath: parsed.filePath,
        className: parsed.className,
        selector,
        attributes: [],
        skipped: false,
      });
      continue;
    }

    const inputs = [
      ...new Set(
        resolvedMembers.filter((m) => m.kind === "input").map((m) => m.publicName)
      ),
    ];
    const outputs = [
      ...new Set(
        resolvedMembers
          .filter((m) => m.kind === "output")
          .map((m) => m.publicName)
      ),
    ];

    progress(
      `  Checking <${selector}> (${parsed.className}) — ${inputs.length} input(s), ${outputs.length} output(s)`
    );

    const usages = deps.collectUsages(selector, roots, inputs, outputs);
    const stats = countStatsForMembers(resolvedMembers, usages);
    attributesChecked += stats.length;

    const record: ComponentScanRecord = {
      repoName: parsed.repoName,
      repoRoot: parsed.repoRoot,
      filePath: parsed.filePath,
      className: parsed.className,
      selector,
      attributes: stats,
      skipped: false,
    };
    records.push(record);

    for (const attr of stats) {
      if (attr.bindingHits > 0) {
        continue;
      }
      unusedFound += 1;
      lastAttribute = attr.publicName;

      if (skipRestOfComponent || skipRestOfRepo) {
        attr.skipAction = skipRestOfRepo ? "nr" : "nc";
        if (skipRestOfRepo) {
          skippedViaNr += 1;
        } else {
          skippedViaNc += 1;
        }
        continue;
      }

      console.log();
      console.log("Unused attribute:");
      console.log(`  Repository:         ${parsed.repoName}`);
      console.log(`  Component class:    ${parsed.className}`);
      console.log(`  Component selector: <${selector}>`);
      console.log(
        `  Attribute:          ${attr.publicName} (${attr.kind}` +
          (attr.propertyName && attr.propertyName !== attr.publicName
            ? `, ts: ${attr.propertyName}`
            : "") +
          ")"
      );
      console.log(`  Defining file:      ${parsed.filePath}`);

      const decision = await deps.promptUnusedDecision(
        `Remove unused ${attr.kind} '${attr.publicName}' from templates and component TS?`
      );

      if (decision === "q") {
        attr.skipAction = "n";
        skippedByUser += 1;
        quitMidRun = true;
        break outer;
      }
      if (decision === "nr") {
        attr.skipAction = "nr";
        skippedViaNr += 1;
        skipRestOfRepo = true;
        skipRestOfComponent = true;
        progress(`  Skipping rest of repository ${parsed.repoName} (NR)`);
        continue;
      }
      if (decision === "nc") {
        attr.skipAction = "nc";
        skippedViaNc += 1;
        skipRestOfComponent = true;
        progress(`  Skipping rest of component ${parsed.className} (NC)`);
        continue;
      }
      if (decision === "no") {
        attr.skipAction = "n";
        skippedByUser += 1;
        continue;
      }

      // yes
      const htmlResult = await deps.removeHtmlApply({
        selector,
        roots,
        inputs: attr.kind === "input" ? [attr.publicName] : [],
        outputs: attr.kind === "output" ? [attr.publicName] : [],
        impactLog: deps.impactLog,
      });
      for (const repo of htmlResult.repos) {
        affectedRepos.add(repo);
      }
      affectedRepos.add(parsed.repoName);
      impactTouched = true;

      let hash: string | undefined;
      if (htmlResult.runHash) {
        hash = htmlResult.runHash;
        changeRunHashes.push(hash);
        changeRunHashInfos.push({
          hash,
          runFile: getChangeRunPath(hash),
        });
      }

      const tsResult = applyIoMemberRemoval(
        parsed.filePath,
        attr.kind,
        attr.publicName,
        attr.propertyName
      );
      let tsFailed = false;
      let tsError: string | undefined;
      if (!tsResult.ok) {
        tsFailed = true;
        tsError = tsResult.error;
        tsRemovalWarnings += 1;
        console.log(
          `  Warning: HTML remove applied, but TypeScript @${
            attr.kind === "input" ? "Input" : "Output"
          } removal failed: ${tsResult.error}`
        );
        console.log(
          "  Remove it manually in the component file if still present."
        );
      } else {
        affectedRepos.add(parsed.repoName);
      }

      attr.removed = true;
      removed += 1;
      removedAttributes.push({
        repoName: parsed.repoName,
        className: parsed.className,
        selector,
        kind: attr.kind,
        publicName: attr.publicName,
        propertyName: attr.propertyName,
        changeRunHash: hash,
        tsRemovalFailed: tsFailed,
        tsError,
      });
      console.log(`  Removed '${attr.publicName}'.`);
    }
  }

  let impactJsonPath: string | undefined;
  let impactCsvPath: string | undefined;
  if (impactTouched || removed > 0) {
    const impact = resolveImpactLogPaths(deps.impactLog);
    impactJsonPath = impact.jsonPath;
    impactCsvPath = impact.csvPath;
  }

  const stoppedAt: StoppedAt = {
    timestamp: new Date().toISOString(),
    repoName: lastRepo || undefined,
    className: lastClass || undefined,
    selector: lastSelector || undefined,
    attribute: lastAttribute || undefined,
    reason: quitMidRun ? "quit" : "completed",
  };

  const summaryBase: Omit<RemoveUnusedSummary, "logPath" | "transcriptLogPath"> =
    {
      componentsScanned,
      componentsSkipped,
      attributesChecked,
      unusedFound,
      removed,
      skippedByUser,
      skippedViaNc,
      skippedViaNr,
      quitMidRun,
      tsRemovalWarnings,
      affectedRepos: [...affectedRepos].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase())
      ),
      changeRunHashes,
      changeRunHashInfos,
      removedAttributes,
      stoppedAt,
      impactJsonPath,
      impactCsvPath,
    };

  const logPath = deps.log
    ? path.resolve(deps.log)
    : defaultRemoveUnusedLogPath();
  ensureDir(path.dirname(logPath));
  fs.writeFileSync(
    logPath,
    formatRemoveUnusedLog(records, summaryBase),
    "utf8"
  );

  return { ...summaryBase, logPath };
}
