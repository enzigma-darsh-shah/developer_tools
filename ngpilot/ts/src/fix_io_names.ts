import * as fs from "fs";
import * as path from "path";
import {
  applyIoMemberRename,
  hasIoNameCollision,
  IoKind,
  IoMember,
  listTsFilesUnderRoots,
  parseComponentFile,
  ParsedComponentFile,
} from "./component_io";
import {
  analyzePublicName,
  formatViolations,
  getNameDictionary,
  isValidJsIdentifier,
  NamingSuggestion,
} from "./naming_rules";
import { ensureDir, resolveImpactLogPaths, resolveLogsDir } from "./paths";
import { getChangeRunPath } from "./runs";

export type FixIoDecision = "yes" | "no" | "nc" | "nr" | "q";

export interface FixIoViolationRecord {
  kind: IoKind;
  publicName: string;
  propertyName: string;
  suggested: string;
  chosen?: string;
  rules: string[];
  skipAction?: "n" | "nc" | "nr";
  renamed?: boolean;
  tsRenameFailed?: boolean;
  tsError?: string;
}

export interface FixIoComponentRecord {
  repoName: string;
  repoRoot: string;
  filePath: string;
  className: string;
  selector: string;
  violations: FixIoViolationRecord[];
  skipped: boolean;
  skipReason?: string;
}

export interface FixIoRenamedRecord {
  repoName: string;
  className: string;
  selector: string;
  kind: IoKind;
  fromName: string;
  toName: string;
  filePath: string;
  changeRunHash?: string;
  tsRenameFailed?: boolean;
  tsError?: string;
}

export interface FixIoStoppedAt {
  timestamp: string;
  repoName?: string;
  className?: string;
  selector?: string;
  attribute?: string;
  reason: "completed" | "quit";
}

export interface FixIoHashInfo {
  hash: string;
  runFile: string;
}

export interface FixIoNamesSummary {
  componentsScanned: number;
  componentsSkipped: number;
  attributesChecked: number;
  violationsFound: number;
  renamed: number;
  skippedByUser: number;
  skippedViaNc: number;
  skippedViaNr: number;
  quitMidRun: boolean;
  tsRenameWarnings: number;
  affectedRepos: string[];
  changeRunHashes: string[];
  changeRunHashInfos: FixIoHashInfo[];
  renamedAttributes: FixIoRenamedRecord[];
  tsFailures: FixIoRenamedRecord[];
  stoppedAt: FixIoStoppedAt;
  logPath: string;
  impactJsonPath?: string;
  impactCsvPath?: string;
  transcriptLogPath?: string;
  nameDictFiles: string[];
}

export interface FixIoNamesDeps {
  skipDirNames: Set<string>;
  nameDictFiles?: string[];
  renameHtmlApply: (args: {
    selector: string;
    roots: string[];
    renameMap: Record<string, string>;
    impactLog?: string;
  }) => Promise<{ repos: string[]; runHash?: string; files: string[] }>;
  promptText: (
    message: string,
    opts?: { required?: boolean; defaultValue?: string; exitOnQuit?: boolean }
  ) => Promise<string>;
  promptFixDecision: (message: string) => Promise<FixIoDecision>;
  log?: string;
  impactLog?: string;
  onProgress?: (message: string) => void;
}

function defaultFixIoLogPath(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .replace("T", "_")
    .slice(0, 19);
  const dir = resolveLogsDir().dir;
  ensureDir(dir);
  return path.join(dir, `fix-io-names-${stamp}.log`);
}

export function printFixIoNamesControlsHelp(): void {
  console.log("fix-io-names controls (shown once):");
  console.log("  Y   Rename this attribute (then confirm/edit suggested name)");
  console.log("  N   Skip this attribute only (default)");
  console.log("  NC  Skip remaining violations on this component");
  console.log("  NR  Skip remaining violations in this repository");
  console.log("  Q   Quit (writes log + prints summary)");
  console.log();
  console.log("Rules:");
  console.log("  - @Output names must not start with 'on'");
  console.log("  - @Input/@Output public names must be camelCase");
  console.log();
}

export function formatFixIoNamesLog(
  records: FixIoComponentRecord[],
  summary: Omit<FixIoNamesSummary, "logPath" | "transcriptLogPath">
): string {
  const lines: string[] = [];
  lines.push("ngpilot fix-io-names report");
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
  lines.push(
    `nameDictFiles: ${summary.nameDictFiles.join("; ") || "(builtin)"}`
  );
  lines.push("");
  lines.push("## Summary");
  lines.push(`componentsScanned: ${summary.componentsScanned}`);
  lines.push(`componentsSkipped: ${summary.componentsSkipped}`);
  lines.push(`attributesChecked: ${summary.attributesChecked}`);
  lines.push(`violationsFound: ${summary.violationsFound}`);
  lines.push(`renamed: ${summary.renamed}`);
  lines.push(`skippedByUser (N): ${summary.skippedByUser}`);
  lines.push(`skippedViaNc: ${summary.skippedViaNc}`);
  lines.push(`skippedViaNr: ${summary.skippedViaNr}`);
  lines.push(`tsRenameWarnings: ${summary.tsRenameWarnings}`);
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

  if (summary.renamedAttributes.length) {
    lines.push("## Renamed attributes");
    for (const item of summary.renamedAttributes) {
      lines.push(
        `  - ${item.repoName} <${item.selector}> ${item.kind} ${item.fromName} → ${item.toName}` +
          (item.changeRunHash ? ` hash=${item.changeRunHash}` : "") +
          (item.tsRenameFailed ? ` TS_FAIL=${item.tsError || "yes"}` : "")
      );
      lines.push(`    file: ${item.filePath}`);
    }
    lines.push("");
  }

  if (summary.tsFailures.length) {
    lines.push("## TypeScript rename failures");
    for (const item of summary.tsFailures) {
      lines.push(
        `  - repo=${item.repoName} class=${item.className} selector=<${item.selector}> attr=${item.fromName}→${item.toName}`
      );
      lines.push(`    file: ${item.filePath}`);
      lines.push(`    error: ${item.tsError || "(unknown)"}`);
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

  const byRepo = new Map<string, FixIoComponentRecord[]>();
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
      if (!record.violations.length) {
        lines.push("violations: (none)");
        continue;
      }
      lines.push("violations:");
      for (const v of record.violations) {
        const flags: string[] = [];
        if (v.renamed) {
          flags.push("RENAMED");
        }
        if (v.skipAction) {
          flags.push(`SKIP_${v.skipAction.toUpperCase()}`);
        }
        if (v.tsRenameFailed) {
          flags.push("TS_FAIL");
        }
        lines.push(
          `  - ${v.kind} ${v.publicName} → suggested ${v.suggested}` +
            (v.chosen ? ` chosen=${v.chosen}` : "") +
            ` | rules=${v.rules.join(",")}` +
            (flags.length ? ` | ${flags.join(",")}` : "")
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

export function printFixIoNamesSummary(summary: FixIoNamesSummary): void {
  console.log();
  console.log(
    summary.quitMidRun
      ? "fix-io-names stopped (quit)"
      : "fix-io-names complete"
  );
  console.log();
  console.log("Counts:");
  console.log(`  Components scanned:     ${summary.componentsScanned}`);
  console.log(`  Components skipped:     ${summary.componentsSkipped}`);
  console.log(`  Attributes checked:     ${summary.attributesChecked}`);
  console.log(`  Violations found:       ${summary.violationsFound}`);
  console.log(`  Renamed:                ${summary.renamed}`);
  console.log(`  Skipped (N):            ${summary.skippedByUser}`);
  console.log(`  Skipped via NC:         ${summary.skippedViaNc}`);
  console.log(`  Skipped via NR:         ${summary.skippedViaNr}`);
  console.log(`  Quit mid-run:           ${summary.quitMidRun ? "yes" : "no"}`);
  console.log(`  TS rename warnings:     ${summary.tsRenameWarnings}`);
  if (summary.renamed > 0) {
    console.log(
      `  Renamed attribute list: see detail log (${summary.renamed} entr${
        summary.renamed === 1 ? "y" : "ies"
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

  if (summary.tsRenameWarnings > 0) {
    console.log();
    console.log(
      `Warning: ${summary.tsRenameWarnings} TypeScript rename(s) failed.`
    );
    for (const fail of summary.tsFailures) {
      console.log(
        `  - repo=${fail.repoName} component=${fail.className} <${fail.selector}> ${fail.fromName}→${fail.toName}`
      );
      console.log(`    file: ${fail.filePath}`);
      if (fail.tsError) {
        console.log(`    error: ${fail.tsError}`);
      }
    }
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

function collectViolations(
  members: IoMember[],
  dict: Set<string>
): Array<{ member: IoMember; analysis: NamingSuggestion }> {
  const out: Array<{ member: IoMember; analysis: NamingSuggestion }> = [];
  for (const member of members) {
    const analysis = analyzePublicName(member.publicName, member.kind, dict);
    if (analysis) {
      out.push({ member, analysis });
    }
  }
  return out;
}

/**
 * Interactive fix-io-names workflow.
 */
export async function runFixIoNames(
  roots: string[],
  deps: FixIoNamesDeps
): Promise<FixIoNamesSummary> {
  const records: FixIoComponentRecord[] = [];
  const affectedRepos = new Set<string>();
  const changeRunHashes: string[] = [];
  const changeRunHashInfos: FixIoHashInfo[] = [];
  const renamedAttributes: FixIoRenamedRecord[] = [];
  const tsFailures: FixIoRenamedRecord[] = [];
  let componentsScanned = 0;
  let componentsSkipped = 0;
  let attributesChecked = 0;
  let violationsFound = 0;
  let renamed = 0;
  let skippedByUser = 0;
  let skippedViaNc = 0;
  let skippedViaNr = 0;
  let tsRenameWarnings = 0;
  let quitMidRun = false;
  let impactTouched = false;

  let lastRepo = "";
  let lastClass = "";
  let lastSelector = "";
  let lastAttribute = "";

  const progress = deps.onProgress || (() => undefined);
  printFixIoNamesControlsHelp();

  const dictFiles = [
    ...(process.env.NGPILOT_NAME_DICT?.trim()
      ? [process.env.NGPILOT_NAME_DICT.trim()]
      : []),
    ...(deps.nameDictFiles || []),
  ];
  const dict = getNameDictionary(deps.nameDictFiles || []);

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
  // Live member lists per file path for collision checks after renames
  const liveMembers = new Map<string, IoMember[]>();

  outer: for (const parsed of parsedFiles) {
    if (parsed.repoName !== currentRepo) {
      currentRepo = parsed.repoName;
      skipRestOfRepo = false;
      skipRestOfComponent = false;
      progress(`\nRepo: ${currentRepo}`);
    }

    if (skipRestOfRepo) {
      componentsScanned += 1;
      componentsSkipped += 1;
      records.push({
        repoName: parsed.repoName,
        repoRoot: parsed.repoRoot,
        filePath: parsed.filePath,
        className: parsed.className,
        selector: parsed.selector || "(unresolved)",
        violations: [],
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
          { required: false, exitOnQuit: false }
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
          violations: [],
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
              `\nEnter public attribute name (Enter = skip)`,
            { required: false, exitOnQuit: false }
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

    liveMembers.set(parsed.filePath, [...resolvedMembers]);
    attributesChecked += resolvedMembers.length;

    const found = collectViolations(resolvedMembers, dict);
    const violationRecords: FixIoViolationRecord[] = found.map(
      ({ member, analysis }) => ({
        kind: member.kind,
        publicName: member.publicName,
        propertyName: member.propertyName,
        suggested: analysis.suggested,
        rules: analysis.violations.map((v) => v.ruleId),
      })
    );

    const record: FixIoComponentRecord = {
      repoName: parsed.repoName,
      repoRoot: parsed.repoRoot,
      filePath: parsed.filePath,
      className: parsed.className,
      selector,
      violations: violationRecords,
      skipped: false,
    };
    records.push(record);

    if (!found.length) {
      progress(
        `  OK <${selector}> (${parsed.className}) — ${resolvedMembers.length} attribute(s)`
      );
      continue;
    }

    progress(
      `  Checking <${selector}> (${parsed.className}) — ${found.length} naming violation(s)`
    );

    for (const { member, analysis } of found) {
      violationsFound += 1;
      lastAttribute = member.publicName;
      const vRec = violationRecords.find(
        (v) =>
          v.publicName === member.publicName &&
          v.propertyName === member.propertyName &&
          v.kind === member.kind
      )!;

      if (skipRestOfComponent || skipRestOfRepo) {
        vRec.skipAction = skipRestOfRepo ? "nr" : "nc";
        if (skipRestOfRepo) {
          skippedViaNr += 1;
        } else {
          skippedViaNc += 1;
        }
        continue;
      }

      console.log();
      console.log("Naming violation:");
      console.log(`  Repository:         ${parsed.repoName}`);
      console.log(`  Component class:    ${parsed.className}`);
      console.log(`  Component selector: <${selector}>`);
      console.log(
        `  Attribute:          ${member.publicName} (${member.kind}` +
          (member.propertyName !== member.publicName
            ? `, ts: ${member.propertyName}`
            : "") +
          ")"
      );
      console.log(`  Rules:              ${formatViolations(analysis.violations)}`);
      console.log(`  Suggested name:     ${analysis.suggested}`);
      console.log(`  Defining file:      ${parsed.filePath}`);

      const decision = await deps.promptFixDecision(
        `Rename '${member.publicName}' to fix naming standards?`
      );

      if (decision === "q") {
        vRec.skipAction = "n";
        skippedByUser += 1;
        quitMidRun = true;
        break outer;
      }
      if (decision === "nr") {
        vRec.skipAction = "nr";
        skippedViaNr += 1;
        skipRestOfRepo = true;
        skipRestOfComponent = true;
        progress(`  Skipping rest of repository ${parsed.repoName} (NR)`);
        continue;
      }
      if (decision === "nc") {
        vRec.skipAction = "nc";
        skippedViaNc += 1;
        skipRestOfComponent = true;
        progress(`  Skipping rest of component ${parsed.className} (NC)`);
        continue;
      }
      if (decision === "no") {
        vRec.skipAction = "n";
        skippedByUser += 1;
        continue;
      }

      // yes → choose name (re-prompt on collision / invalid)
      let chosen = analysis.suggested;
      while (true) {
        const typed = (
          await deps.promptText(`Suggested name`, {
            defaultValue: chosen,
            exitOnQuit: false,
          })
        ).trim();
        if (typed.toLowerCase() === "q") {
          quitMidRun = true;
          vRec.skipAction = "n";
          skippedByUser += 1;
          break outer;
        }
        const candidate = typed || analysis.suggested;
        if (!isValidJsIdentifier(candidate)) {
          console.log(
            `  Warning: '${candidate}' is not a valid identifier. Try again.`
          );
          continue;
        }
        const membersNow = liveMembers.get(parsed.filePath) || resolvedMembers;
        if (
          hasIoNameCollision(membersNow, candidate, {
            publicName: member.publicName,
            propertyName: member.propertyName,
          })
        ) {
          console.log(
            `  Warning: '${candidate}' already exists on this component. Choose another name.`
          );
          continue;
        }
        chosen = candidate;
        break;
      }
      if (quitMidRun) {
        break outer;
      }

      vRec.chosen = chosen;

      // HTML rename across roots
      const htmlResult = await deps.renameHtmlApply({
        selector,
        roots,
        renameMap: { [member.publicName]: chosen },
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

      const newPropertyName =
        member.propertyName === member.publicName ? chosen : member.propertyName;

      const tsResult = applyIoMemberRename(parsed.filePath, {
        kind: member.kind,
        publicName: member.publicName,
        propertyName: member.propertyName,
        newPublicName: chosen,
        newPropertyName,
      });

      const renamedRec: FixIoRenamedRecord = {
        repoName: parsed.repoName,
        className: parsed.className,
        selector,
        kind: member.kind,
        fromName: member.publicName,
        toName: chosen,
        filePath: parsed.filePath,
        changeRunHash: hash,
      };

      if (!tsResult.ok) {
        tsRenameWarnings += 1;
        renamedRec.tsRenameFailed = true;
        renamedRec.tsError = tsResult.error;
        vRec.tsRenameFailed = true;
        vRec.tsError = tsResult.error;
        tsFailures.push(renamedRec);
        console.log(
          `  Warning: HTML rename applied, but TypeScript update failed.`
        );
        console.log(`    Repository: ${parsed.repoName}`);
        console.log(`    Component:  ${parsed.className} <${selector}>`);
        console.log(`    Attribute:  ${member.publicName} → ${chosen}`);
        console.log(`    File:       ${parsed.filePath}`);
        console.log(`    Error:      ${tsResult.error}`);
      } else {
        // Update live members for further collision checks
        const live = liveMembers.get(parsed.filePath) || [];
        for (const m of live) {
          if (
            m.publicName === member.publicName &&
            m.propertyName === member.propertyName
          ) {
            m.publicName = chosen;
            m.propertyName = newPropertyName;
          }
        }
      }

      vRec.renamed = true;
      renamed += 1;
      renamedAttributes.push(renamedRec);
      console.log(`  Renamed '${member.publicName}' → '${chosen}'.`);
    }
  }

  let impactJsonPath: string | undefined;
  let impactCsvPath: string | undefined;
  if (impactTouched || renamed > 0) {
    const impact = resolveImpactLogPaths(deps.impactLog);
    impactJsonPath = impact.jsonPath;
    impactCsvPath = impact.csvPath;
  }

  const stoppedAt: FixIoStoppedAt = {
    timestamp: new Date().toISOString(),
    repoName: lastRepo || undefined,
    className: lastClass || undefined,
    selector: lastSelector || undefined,
    attribute: lastAttribute || undefined,
    reason: quitMidRun ? "quit" : "completed",
  };

  const summaryBase: Omit<FixIoNamesSummary, "logPath" | "transcriptLogPath"> = {
    componentsScanned,
    componentsSkipped,
    attributesChecked,
    violationsFound,
    renamed,
    skippedByUser,
    skippedViaNc,
    skippedViaNr,
    quitMidRun,
    tsRenameWarnings,
    affectedRepos: [...affectedRepos].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase())
    ),
    changeRunHashes,
    changeRunHashInfos,
    renamedAttributes,
    tsFailures,
    stoppedAt,
    impactJsonPath,
    impactCsvPath,
    nameDictFiles: dictFiles,
  };

  const logPath = deps.log
    ? path.resolve(deps.log)
    : defaultFixIoLogPath();
  ensureDir(path.dirname(logPath));
  fs.writeFileSync(logPath, formatFixIoNamesLog(records, summaryBase), "utf8");

  return { ...summaryBase, logPath };
}
