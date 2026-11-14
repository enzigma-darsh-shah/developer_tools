import * as fs from "fs";
import { resolveComponentAffected } from "./component_selector";
import { ensureParentDir, resolveImpactLogPaths } from "./paths";
import { uuidv7 } from "./uuidv7";

export interface ImpactRecord {
  id: string;
  "github-user-name": string;
  timestamp: string;
  selector: string;
  "operation-name": "rename" | "remove";
  "attribute-affected": string;
  notes: string;
  "repository-affected": string;
  "component-affected": string;
  "file/line-affected": string;
}

export interface ImpactChangeInput {
  filePath: string;
  repo: string;
  line: number;
  attributeAffected: string;
  notes: string;
}

const CSV_HEADERS: Array<keyof ImpactRecord> = [
  "id",
  "github-user-name",
  "timestamp",
  "selector",
  "operation-name",
  "attribute-affected",
  "notes",
  "repository-affected",
  "component-affected",
  "file/line-affected",
];

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function recordToCsvRow(record: ImpactRecord): string {
  return CSV_HEADERS.map((key) => csvEscape(String(record[key] ?? ""))).join(
    ","
  );
}

function loadJsonRecords(jsonPath: string): ImpactRecord[] {
  if (!fs.existsSync(jsonPath)) {
    return [];
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    return Array.isArray(parsed) ? (parsed as ImpactRecord[]) : [];
  } catch {
    return [];
  }
}

function appendCsv(csvPath: string, records: ImpactRecord[]): void {
  ensureParentDir(csvPath);
  const needsHeader =
    !fs.existsSync(csvPath) || fs.statSync(csvPath).size === 0;
  const lines: string[] = [];
  if (needsHeader) {
    lines.push(CSV_HEADERS.join(","));
  }
  for (const record of records) {
    lines.push(recordToCsvRow(record));
  }
  fs.appendFileSync(csvPath, lines.join("\n") + "\n", "utf8");
}

function appendJson(jsonPath: string, records: ImpactRecord[]): void {
  ensureParentDir(jsonPath);
  const existing = loadJsonRecords(jsonPath);
  existing.push(...records);
  fs.writeFileSync(jsonPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export function buildImpactRecords(options: {
  githubUserName: string;
  selector: string;
  operation: "rename" | "remove";
  changes: ImpactChangeInput[];
  timestamp?: string;
}): ImpactRecord[] {
  const timestamp = options.timestamp || new Date().toISOString();
  const componentCache = new Map<string, string>();
  const records: ImpactRecord[] = [];

  for (const change of options.changes) {
    const abs = change.filePath;
    let component = componentCache.get(abs);
    if (component === undefined) {
      component = resolveComponentAffected(abs);
      componentCache.set(abs, component);
    }
    records.push({
      id: uuidv7(),
      "github-user-name": options.githubUserName,
      timestamp,
      selector: options.selector,
      "operation-name": options.operation,
      "attribute-affected": change.attributeAffected,
      notes: change.notes,
      "repository-affected": change.repo,
      "component-affected": component,
      "file/line-affected": `${abs}:${change.line}`,
    });
  }
  return records;
}

/**
 * Append impact records to the configured JSON + CSV sibling files.
 * Returns the resolved paths that were written.
 */
export function appendImpactRecords(
  records: ImpactRecord[],
  impactLogCli?: string | null
): { jsonPath: string; csvPath: string; count: number } {
  if (!records.length) {
    const paths = resolveImpactLogPaths(impactLogCli);
    return { jsonPath: paths.jsonPath, csvPath: paths.csvPath, count: 0 };
  }
  const paths = resolveImpactLogPaths(impactLogCli);
  appendJson(paths.jsonPath, records);
  appendCsv(paths.csvPath, records);
  return {
    jsonPath: paths.jsonPath,
    csvPath: paths.csvPath,
    count: records.length,
  };
}
