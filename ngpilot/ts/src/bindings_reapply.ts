/**
 * Re-apply rename/remove binding transforms onto arbitrary HTML text.
 * Used by commit when unified-patch isolation cannot apply cleanly.
 */

export interface ReapplyOptions {
  selector: string;
  command: "rename" | "remove";
  renameMap?: Record<string, string>;
  inputs?: string[];
  outputs?: string[];
}

function camelToKebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
}

function nameVariants(name: string): string[] {
  const raw = name.trim();
  if (!raw) {
    return [];
  }
  const kebab = camelToKebab(raw);
  const variants = [raw];
  if (kebab !== raw) {
    variants.push(kebab);
  }
  if (raw.includes("-")) {
    const parts = raw.split("-");
    const camel =
      parts[0] +
      parts
        .slice(1)
        .filter(Boolean)
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join("");
    if (camel && !variants.includes(camel)) {
      variants.push(camel);
    }
  }
  return variants;
}

function indexInsideQuotes(text: string, index: number): boolean {
  let inQuote: string | null = null;
  let i = 0;
  while (i < text.length && i < index) {
    const ch = text[i];
    if (inQuote) {
      if (ch === "\\" && i + 1 < text.length) {
        i += 2;
        continue;
      }
      if (ch === inQuote) {
        inQuote = null;
      }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    }
    i += 1;
  }
  return inQuote !== null;
}

function attrPatterns(name: string): Array<[string, RegExp]> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = String.raw`(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?`;
  return [
    ["two-way", new RegExp(String.raw`\[\(${esc}\)\]${value}`, "g")],
    ["property", new RegExp(String.raw`\[${esc}\]${value}`, "g")],
    ["output", new RegExp(String.raw`\(${esc}\)${value}`, "g")],
    [
      "attribute",
      new RegExp(
        String.raw`(?<![\w.\-\[\(\)\]#/])\b${esc}\b` +
          String.raw`(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?=[\s/>]))`,
        "g"
      ),
    ],
  ];
}

interface BindingHit {
  propertyName: string;
  matchedName: string;
  kind: string;
  start: number;
  end: number;
  attrText: string;
}

function findOpeningTagSpans(
  text: string,
  selector: string
): Array<[number, number]> {
  const pattern = new RegExp(
    `<${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "gi"
  );
  const spans: Array<[number, number]> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const i = match.index;
    const n = text.length;
    let inQuote: string | null = null;
    let j = i + match[0].length;
    while (j < n) {
      const ch = text[j];
      if (inQuote) {
        if (ch === inQuote) {
          inQuote = null;
        } else if (ch === "\\" && j + 1 < n) {
          j += 1;
        }
      } else if (ch === '"' || ch === "'") {
        inQuote = ch;
      } else if (ch === ">") {
        spans.push([i, j + 1]);
        break;
      }
      j += 1;
    }
  }
  return spans;
}

function findBindingsInTag(
  tagText: string,
  tagStart: number,
  propertyNames: string[],
  kinds: string[]
): BindingHit[] {
  const allowed = new Set(kinds);
  const variantToCanonical = new Map<string, string>();
  for (const canonical of propertyNames) {
    for (const variant of nameVariants(canonical)) {
      if (!variantToCanonical.has(variant)) {
        variantToCanonical.set(variant, canonical);
      }
    }
  }

  const matches: BindingHit[] = [];
  const occupied: Array<[number, number]> = [];
  const overlaps = (a: number, b: number): boolean =>
    occupied.some(([s, e]) => !(b <= s || a >= e));

  const variantsSorted = [...variantToCanonical.keys()].sort(
    (a, b) => b.length - a.length
  );

  for (const variant of variantsSorted) {
    const canonical = variantToCanonical.get(variant)!;
    for (const [kind, pattern] of attrPatterns(variant)) {
      if (!allowed.has(kind)) {
        continue;
      }
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(tagText)) !== null) {
        const localStart = match.index;
        const localEnd = match.index + match[0].length;
        if (indexInsideQuotes(tagText, localStart)) {
          continue;
        }
        if (overlaps(localStart, localEnd)) {
          continue;
        }
        matches.push({
          propertyName: canonical,
          matchedName: variant,
          kind,
          start: tagStart + localStart,
          end: tagStart + localEnd,
          attrText: match[0],
        });
        occupied.push([localStart, localEnd]);
      }
    }
  }

  return matches.sort((a, b) => a.start - b.start);
}

function replaceNameInAttr(
  attrText: string,
  oldNames: string[],
  newName: string
): string {
  const unique = [...new Set(oldNames)].sort((a, b) => b.length - a.length);
  for (const old of unique) {
    const esc = old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let updated = attrText.replace(
      new RegExp(String.raw`\[\(${esc}\)\]`),
      `[(${newName})]`
    );
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\[${esc}\]`), `[${newName}]`);
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\(${esc}\)`), `(${newName})`);
    if (updated !== attrText) {
      return updated;
    }
    updated = attrText.replace(new RegExp(String.raw`\b${esc}\b`), newName);
    if (updated !== attrText) {
      return updated;
    }
  }
  return attrText;
}

function collapseAttrWhitespace(
  text: string,
  removedStart: number,
  removedEnd: number
): string {
  let start = removedStart;
  let end = removedEnd;
  if (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) {
    start -= 1;
  } else if (end < text.length && (text[end] === " " || text[end] === "\t")) {
    end += 1;
  }
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", end);
  if (lineEnd < 0) {
    lineEnd = text.length;
  }
  const before = text.slice(lineStart, start);
  const after = text.slice(end, lineEnd);
  if (before.trim() === "" && after.trim() === "") {
    if (lineEnd < text.length && text[lineEnd] === "\n") {
      return text.slice(0, lineStart) + text.slice(lineEnd + 1);
    }
    if (lineStart > 0 && text[lineStart - 1] === "\n") {
      return text.slice(0, lineStart - 1) + text.slice(lineEnd);
    }
  }
  return text.slice(0, start) + text.slice(end);
}

function collectBindings(
  text: string,
  selector: string,
  inputNames: string[],
  outputNames: string[]
): BindingHit[] {
  const spans = findOpeningTagSpans(text, selector);
  const bindings: BindingHit[] = [];
  for (const [tagStart, tagEnd] of spans) {
    const tagText = text.slice(tagStart, tagEnd);
    if (inputNames.length) {
      bindings.push(
        ...findBindingsInTag(tagText, tagStart, inputNames, [
          "property",
          "attribute",
          "two-way",
        ])
      );
    }
    if (outputNames.length) {
      bindings.push(
        ...findBindingsInTag(tagText, tagStart, outputNames, [
          "output",
          "two-way",
        ])
      );
    }
  }
  const uniq = new Map<string, BindingHit>();
  for (const binding of bindings) {
    uniq.set(`${binding.start}:${binding.end}:${binding.kind}`, binding);
  }
  return [...uniq.values()].sort((a, b) => b.start - a.start);
}

/**
 * Apply the change-run's rename/remove operation onto HTML content from the
 * target branch tip. Returns null if nothing changed (already applied or no hits).
 */
export function reapplyBindingsToHtml(
  html: string,
  opts: ReapplyOptions
): string | null {
  if (opts.command === "rename") {
    const renameMap = opts.renameMap || {};
    const keys = Object.keys(renameMap);
    if (!keys.length) {
      return null;
    }
    const bindings = collectBindings(html, opts.selector, keys, keys);
    if (!bindings.length) {
      return null;
    }
    let updated = html;
    for (const binding of bindings) {
      const newCanonical = renameMap[binding.propertyName];
      if (!newCanonical) {
        continue;
      }
      let newTemplateName = newCanonical;
      if (binding.matchedName.includes("-") && !newCanonical.includes("-")) {
        newTemplateName = camelToKebab(newCanonical);
      }
      const newAttr = replaceNameInAttr(
        binding.attrText,
        [...nameVariants(binding.propertyName), binding.matchedName],
        newTemplateName
      );
      if (newAttr === binding.attrText) {
        continue;
      }
      updated =
        updated.slice(0, binding.start) + newAttr + updated.slice(binding.end);
    }
    return updated === html ? null : updated;
  }

  const inputNames = opts.inputs || [];
  const outputNames = opts.outputs || [];
  const wanted = [...inputNames, ...outputNames];
  if (!wanted.length) {
    return null;
  }
  const bindings = collectBindings(
    html,
    opts.selector,
    inputNames,
    outputNames
  ).filter((b) => wanted.includes(b.propertyName));
  if (!bindings.length) {
    return null;
  }
  let updated = html;
  for (const binding of bindings) {
    updated = collapseAttrWhitespace(updated, binding.start, binding.end);
  }
  return updated === html ? null : updated;
}
