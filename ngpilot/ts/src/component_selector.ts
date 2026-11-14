import * as fs from "fs";
import * as path from "path";

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function htmlBasename(htmlPath: string): string {
  return path.basename(htmlPath);
}

function htmlStem(htmlPath: string): string {
  return path.basename(htmlPath, path.extname(htmlPath));
}

function templateUrlReferencesHtml(tsSource: string, htmlFile: string): boolean {
  const base = htmlBasename(htmlFile).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `templateUrl\\s*:\\s*['"\`](?:\\.\\/)?(?:[^'"\`]*[\\\\/])?${base}['"\`]`,
    "i"
  );
  return re.test(tsSource);
}

/**
 * Extract @Component selector from a TS file.
 * Supports selector: 'literal' / "literal" and selector: CONST where CONST is a
 * same-file string const. Imported selectors are not resolved.
 */
export function extractSelectorFromTs(source: string): string | null {
  const selectorMatch = source.match(
    /@Component\s*\(\s*\{[\s\S]*?\bselector\s*:\s*([^,\n}]+)/
  );
  if (!selectorMatch) {
    return null;
  }
  const raw = selectorMatch[1].trim();

  const quoted = raw.match(/^(['"`])([^'"`]*)\1/);
  if (quoted) {
    return quoted[2].trim() || null;
  }

  const ident = raw.match(/^([A-Za-z_$][\w$]*)/);
  if (!ident) {
    return null;
  }
  const name = ident[1];
  // Same-file const/let/var NAME = 'value' (optional type annotation)
  const constRe = new RegExp(
    `(?:const|let|var)\\s+${name.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    )}\\s*(?::\\s*[^=]+)?=\\s*(['"\`])([^'"\`]*)\\1`
  );
  const constMatch = source.match(constRe);
  if (constMatch) {
    return constMatch[2].trim() || null;
  }
  return null;
}

function listCandidateTsFiles(htmlPath: string): string[] {
  const dir = path.dirname(htmlPath);
  const stem = htmlStem(htmlPath);
  const out: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }

  const preferred = [
    path.join(dir, `${stem}.ts`),
    path.join(dir, `${stem}.component.ts`),
  ];
  for (const p of preferred) {
    if (fs.existsSync(p)) {
      out.push(p);
    }
  }

  for (const name of entries) {
    if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".spec.ts")) {
      continue;
    }
    const full = path.join(dir, name);
    if (!out.includes(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve the Angular component selector that owns this HTML template.
 *
 * 1. Nearby .ts with templateUrl pointing at this HTML
 * 2. Same-stem siblings (abx-table.ts / abx-table.component.ts)
 * 3. @Component selector literal or same-file const
 * 4. HTML stem (abx-table.html → abx-table)
 * 5. Empty string
 */
export function resolveComponentAffected(htmlPath: string): string {
  const resolved = path.resolve(htmlPath);
  const candidates = listCandidateTsFiles(resolved);

  let selectedTs: string | null = null;
  for (const tsPath of candidates) {
    const source = readText(tsPath);
    if (!source) {
      continue;
    }
    if (templateUrlReferencesHtml(source, resolved)) {
      selectedTs = tsPath;
      break;
    }
  }

  if (!selectedTs) {
    const stem = htmlStem(resolved);
    const dir = path.dirname(resolved);
    for (const name of [`${stem}.ts`, `${stem}.component.ts`]) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) {
        selectedTs = full;
        break;
      }
    }
  }

  if (selectedTs) {
    const source = readText(selectedTs);
    if (source) {
      const selector = extractSelectorFromTs(source);
      if (selector) {
        return selector;
      }
    }
  }

  const stem = htmlStem(resolved);
  return stem || "";
}
