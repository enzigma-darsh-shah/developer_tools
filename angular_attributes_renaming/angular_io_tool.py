#!/usr/bin/env python3
"""Find, rename, or remove Angular component input/output bindings in HTML templates.

Searches HTML files with ripgrep (rg), then parses opening tags so multi-line
usages and camelCase/kebab-case binding forms are handled correctly.

Examples:
  python angular_io_tool.py find --selector abx-icon --inputs isCustomIcon,isUtilityIcon
  python angular_io_tool.py rename --selector abx-icon --rename isCustomIcon=isCustom --apply
  python angular_io_tool.py remove --selector abx-icon --inputs isCustomIcon --apply
  python angular_io_tool.py report --selector abx-icon --inputs isCustomIcon -o report.md
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Sequence


SKIP_DIR_NAMES = frozenset(
    {
        ".git",
        ".angular",
        "node_modules",
        "dist",
        "coverage",
        "tmp",
        "out-tsc",
        ".idea",
        ".vscode",
        "__pycache__",
    }
)


# ---------------------------------------------------------------------------
# Terminal helpers
# ---------------------------------------------------------------------------


def use_color() -> bool:
    return not os.environ.get("NO_COLOR") and sys.stdout.isatty()


def enable_windows_ansi() -> None:
    if sys.platform != "win32" or not use_color():
        return
    handle = ctypes.windll.kernel32.GetStdHandle(-11)
    mode = ctypes.c_uint()
    if ctypes.windll.kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
        ctypes.windll.kernel32.SetConsoleMode(handle, mode.value | 0x0004)


def paint(text: str, code: str) -> str:
    if not use_color():
        return text
    return f"\033[{code}m{text}\033[0m"


def bold(text: str) -> str:
    return paint(text, "1")


def dim(text: str) -> str:
    return paint(text, "2")


def green(text: str) -> str:
    return paint(text, "32")


def yellow(text: str) -> str:
    return paint(text, "33")


def cyan(text: str) -> str:
    return paint(text, "36")


def red(text: str) -> str:
    return paint(text, "31")


# ---------------------------------------------------------------------------
# Name / CLI parsing helpers
# ---------------------------------------------------------------------------


def camel_to_kebab(name: str) -> str:
    return re.sub(r"([a-z0-9])([A-Z])", r"\1-\2", name).replace("_", "-").lower()


def name_variants(name: str) -> list[str]:
    """Return unique template name forms for a TypeScript-style property name."""
    raw = name.strip()
    if not raw:
        return []
    kebab = camel_to_kebab(raw)
    variants = [raw]
    if kebab != raw:
        variants.append(kebab)
    # If user passed kebab already, also try a best-effort camelCase.
    if "-" in raw:
        parts = raw.split("-")
        camel = parts[0] + "".join(p[:1].upper() + p[1:] for p in parts[1:] if p)
        if camel and camel not in variants:
            variants.append(camel)
    return variants


def parse_name_list(values: Sequence[str] | None) -> list[str]:
    """Parse --inputs/--outputs values.

    Accepts:
      --inputs a,b
      --inputs [a, b]
      --inputs a b
      --inputs a --inputs b
    """
    if not values:
        return []
    names: list[str] = []
    for value in values:
        text = value.strip()
        if text.startswith("[") and text.endswith("]"):
            text = text[1:-1]
        for part in re.split(r"[,\s]+", text):
            part = part.strip().strip("[]")
            if part:
                names.append(part)
    # Preserve order, drop duplicates.
    seen: set[str] = set()
    ordered: list[str] = []
    for name in names:
        if name not in seen:
            seen.add(name)
            ordered.append(name)
    return ordered


def parse_rename_map(values: Sequence[str] | None) -> dict[str, str]:
    """Parse --rename old=new,old2=new2 (brackets optional)."""
    if not values:
        return {}
    mapping: dict[str, str] = {}
    for value in values:
        text = value.strip()
        if text.startswith("[") and text.endswith("]"):
            text = text[1:-1]
        for part in re.split(r"[,\s]+", text):
            part = part.strip().strip("[]")
            if not part:
                continue
            if "=" not in part:
                raise SystemExit(f"Invalid --rename entry {part!r}; expected old=new")
            old, new = part.split("=", 1)
            old, new = old.strip(), new.strip()
            if not old or not new:
                raise SystemExit(f"Invalid --rename entry {part!r}; expected old=new")
            mapping[old] = new
    return mapping


# ---------------------------------------------------------------------------
# Filesystem / ripgrep
# ---------------------------------------------------------------------------


def require_rg() -> str:
    path = shutil.which("rg")
    if path is None:
        raise SystemExit(
            "ripgrep (rg) was not found on PATH. Install it, then re-run this tool."
        )
    return path


def normalize_roots(roots: Sequence[str] | None) -> list[Path]:
    if not roots:
        return [Path.cwd().resolve()]
    resolved: list[Path] = []
    for raw in roots:
        for piece in re.split(r"[;]+", raw):
            piece = piece.strip().strip('"')
            if not piece:
                continue
            path = Path(piece).expanduser().resolve()
            if not path.exists():
                raise SystemExit(f"Root path does not exist: {path}")
            if not path.is_dir():
                raise SystemExit(f"Root path is not a directory: {path}")
            resolved.append(path)
    if not resolved:
        return [Path.cwd().resolve()]
    # Unique, preserve order.
    seen: set[Path] = set()
    out: list[Path] = []
    for path in resolved:
        if path not in seen:
            seen.add(path)
            out.append(path)
    return out


def git_toplevel(path: Path) -> Path | None:
    try:
        result = subprocess.run(
            ["git", "-C", str(path), "rev-parse", "--show-toplevel"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError:
        return None
    if result.returncode != 0:
        return None
    top = result.stdout.strip()
    return Path(top).resolve() if top else None


def repo_label_for(file_path: Path, roots: Sequence[Path]) -> str:
    """Best-effort repository / project name for reporting.

    Prefer a git toplevel that sits under a search root (typical when --roots
    points at a folder containing many clones). If the file lives in a project
    subfolder of the root and git is outside that root, use the first path
    segment under the root instead.
    """
    resolved = file_path.resolve()
    git_root = git_toplevel(file_path.parent)
    project_dir_names = frozenset({"src", "projects", "apps", "libs", "public", "web", "client"})

    for root in roots:
        try:
            relative = resolved.relative_to(root)
        except ValueError:
            continue

        if git_root is not None:
            try:
                git_root.relative_to(root)
            except ValueError:
                git_under_root = False
            else:
                git_under_root = True
            if git_under_root:
                return git_root.name if git_root != root else root.name

        parts = relative.parts
        if not parts:
            return root.name
        if parts[0].lower() in project_dir_names:
            return root.name
        return parts[0]

    if git_root is not None:
        return git_root.name
    return resolved.parent.name or str(resolved.parent)


def rg_find_selector_hits(selector: str, roots: Sequence[Path]) -> list[tuple[Path, int]]:
    """Return (absolute_html_path, 1-based_line) hits for opening tags of selector."""
    rg = require_rg()
    pattern = rf"<{re.escape(selector)}\b"
    # --glob '!dir/**' style exclusions keep searches out of build artifacts.
    cmd: list[str] = [
        rg,
        "--glob",
        "*.html",
        "--line-number",
        "--with-filename",
        "--no-heading",
        "--color",
        "never",
        "--hidden",
    ]
    for name in sorted(SKIP_DIR_NAMES):
        cmd.extend(["--glob", f"!{name}/**"])
    cmd.append(pattern)
    cmd.extend(str(root) for root in roots)

    try:
        result = subprocess.run(
            cmd,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise SystemExit(f"failed to run ripgrep: {exc}") from exc

    # 0 = matches, 1 = no matches, 2 = error
    if result.returncode not in (0, 1):
        err = (result.stderr or result.stdout).strip() or f"rg exited {result.returncode}"
        raise SystemExit(f"ripgrep failed: {err}")

    hits: list[tuple[Path, int]] = []
    for line in result.stdout.splitlines():
        # path:line:content  (Windows paths contain drive colon — split carefully)
        match = re.match(r"^(.*):(\d+):(.*)$", line)
        if not match:
            continue
        path_text, line_text, _content = match.groups()
        hits.append((Path(path_text).resolve(), int(line_text)))
    return hits


# ---------------------------------------------------------------------------
# HTML opening-tag extraction and binding parsing
# ---------------------------------------------------------------------------


def find_opening_tag_span(text: str, start_index: int, selector: str) -> tuple[int, int] | None:
    """Return [start, end) of the opening tag beginning at/after start_index."""
    pattern = re.compile(rf"<{re.escape(selector)}\b", re.IGNORECASE)
    match = pattern.search(text, start_index)
    if not match:
        return None
    i = match.start()
    n = len(text)
    in_quote: str | None = None
    j = match.end()
    while j < n:
        ch = text[j]
        if in_quote:
            if ch == in_quote:
                in_quote = None
            elif ch == "\\" and j + 1 < n:
                j += 1
        else:
            if ch in ('"', "'"):
                in_quote = ch
            elif ch == ">":
                return i, j + 1
        j += 1
    return None


def line_col_at(text: str, index: int) -> tuple[int, int]:
    line = text.count("\n", 0, index) + 1
    last_nl = text.rfind("\n", 0, index)
    col = index - last_nl
    return line, col


def snippet_for_span(text: str, start: int, end: int, max_lines: int = 6) -> str:
    line_start = text.rfind("\n", 0, start) + 1
    # Include through end of the last touched line.
    line_end = text.find("\n", end - 1 if end > 0 else 0)
    if line_end < 0:
        line_end = len(text)
    block = text[line_start:line_end].rstrip()
    lines = block.splitlines()
    if len(lines) > max_lines:
        head = "\n".join(lines[: max_lines - 1])
        return head + "\n  ..."
    return block


@dataclass(frozen=True)
class BindingMatch:
    property_name: str  # canonical name requested by the user
    matched_name: str  # name as it appeared in the template
    kind: str  # property | attribute | two-way | output
    start: int  # absolute index in file of the attribute
    end: int  # absolute index after the attribute
    line: int
    column: int
    attr_text: str


def _attr_patterns(name: str) -> list[tuple[str, re.Pattern[str]]]:
    """Build binding patterns for one template name form."""
    esc = re.escape(name)
    # Value: "..." or '...' (Angular templates almost always quote bindings).
    value = r"""(?:\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))?"""
    return [
        ("two-way", re.compile(rf"\[\({esc}\)\]{value}")),
        ("property", re.compile(rf"\[{esc}\]{value}")),
        ("output", re.compile(rf"\({esc}\){value}")),
        # Plain attribute last so [x] / (x) win when overlapping conceptually.
        ("attribute", re.compile(rf"(?<![\w\-\[\(\)\]])\b{esc}\b{value}")),
    ]


def find_bindings_in_tag(
    tag_text: str,
    tag_start: int,
    file_text: str,
    property_names: Sequence[str],
    kinds: Sequence[str],
) -> list[BindingMatch]:
    """Find requested bindings inside a single opening tag string."""
    allowed = set(kinds)
    # Map every variant back to the canonical requested name.
    variant_to_canonical: dict[str, str] = {}
    for canonical in property_names:
        for variant in name_variants(canonical):
            variant_to_canonical.setdefault(variant, canonical)

    matches: list[BindingMatch] = []
    occupied: list[tuple[int, int]] = []

    def overlaps(a: int, b: int) -> bool:
        return any(not (b <= s or a >= e) for s, e in occupied)

    # Search longer / more specific names first to avoid partial confusion.
    variants_sorted = sorted(variant_to_canonical.keys(), key=len, reverse=True)

    for variant in variants_sorted:
        canonical = variant_to_canonical[variant]
        for kind, pattern in _attr_patterns(variant):
            if kind not in allowed:
                continue
            for match in pattern.finditer(tag_text):
                local_start, local_end = match.start(), match.end()
                # Skip if this looks like part of a larger already-chosen attr.
                if overlaps(local_start, local_end):
                    continue
                abs_start = tag_start + local_start
                abs_end = tag_start + local_end
                line, col = line_col_at(file_text, abs_start)
                matches.append(
                    BindingMatch(
                        property_name=canonical,
                        matched_name=variant,
                        kind=kind,
                        start=abs_start,
                        end=abs_end,
                        line=line,
                        column=col,
                        attr_text=match.group(0),
                    )
                )
                occupied.append((local_start, local_end))

    matches.sort(key=lambda m: (m.start, m.property_name))
    return matches


@dataclass
class UsageHit:
    file_path: Path
    repo: str
    selector: str
    tag_start: int
    tag_end: int
    tag_line: int
    tag_column: int
    snippet: str
    bindings: list[BindingMatch] = field(default_factory=list)


def collect_usages(
    selector: str,
    roots: Sequence[Path],
    input_names: Sequence[str],
    output_names: Sequence[str],
) -> list[UsageHit]:
    """Search HTML under roots and return component usages with matching bindings."""
    if not input_names and not output_names:
        # Selector-only search: still report every usage tag.
        wanted_inputs: list[str] = []
        wanted_outputs: list[str] = []
        filter_bindings = False
    else:
        wanted_inputs = list(input_names)
        wanted_outputs = list(output_names)
        filter_bindings = True

    rg_hits = rg_find_selector_hits(selector, roots)
    # Group by file to parse each file once.
    by_file: dict[Path, list[int]] = defaultdict(list)
    for path, line_no in rg_hits:
        by_file[path].append(line_no)

    usages: list[UsageHit] = []
    for file_path, line_nos in sorted(by_file.items(), key=lambda item: str(item[0]).lower()):
        try:
            text = file_path.read_text(encoding="utf-8")
        except OSError as exc:
            print(red(f"Warning: could not read {file_path}: {exc}"), file=sys.stderr)
            continue

        # Convert line numbers to approximate offsets, then extract tags.
        line_starts = [0]
        for match in re.finditer(r"\n", text):
            line_starts.append(match.end())

        seen_spans: set[tuple[int, int]] = set()
        repo = repo_label_for(file_path, roots)

        for line_no in sorted(set(line_nos)):
            if line_no < 1 or line_no > len(line_starts):
                continue
            approx = line_starts[line_no - 1]
            span = find_opening_tag_span(text, approx, selector)
            if span is None:
                # Try from start of line-1 window in case rg matched oddly.
                span = find_opening_tag_span(text, max(0, approx - 200), selector)
            if span is None:
                continue
            if span in seen_spans:
                continue
            seen_spans.add(span)
            tag_start, tag_end = span
            tag_text = text[tag_start:tag_end]
            tag_line, tag_col = line_col_at(text, tag_start)

            bindings: list[BindingMatch] = []
            if wanted_inputs:
                bindings.extend(
                    find_bindings_in_tag(
                        tag_text,
                        tag_start,
                        text,
                        wanted_inputs,
                        kinds=("property", "attribute", "two-way"),
                    )
                )
            if wanted_outputs:
                bindings.extend(
                    find_bindings_in_tag(
                        tag_text,
                        tag_start,
                        text,
                        wanted_outputs,
                        kinds=("output", "two-way"),
                    )
                )
            # Deduplicate identical spans (e.g. two-way matched in both lists).
            uniq: dict[tuple[int, int, str], BindingMatch] = {}
            for binding in bindings:
                key = (binding.start, binding.end, binding.kind)
                uniq[key] = binding
            bindings = sorted(uniq.values(), key=lambda b: b.start)

            if filter_bindings and not bindings:
                continue

            usages.append(
                UsageHit(
                    file_path=file_path,
                    repo=repo,
                    selector=selector,
                    tag_start=tag_start,
                    tag_end=tag_end,
                    tag_line=tag_line,
                    tag_column=tag_col,
                    snippet=snippet_for_span(text, tag_start, tag_end),
                    bindings=bindings,
                )
            )
    return usages


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ChangeDetail:
    line: int
    column: int
    message: str


@dataclass
class FileChangePlan:
    file_path: Path
    repo: str
    original: str
    updated: str
    change_count: int
    details: list[ChangeDetail]


def _replace_name_in_attr(attr_text: str, old_names: Sequence[str], new_name: str) -> str:
    """Rename the binding identifier inside an attribute token, keep brackets/value."""
    for old in sorted(set(old_names), key=len, reverse=True):
        esc = re.escape(old)
        # two-way [(old)]
        updated = re.sub(rf"\[\({esc}\)\]", f"[({new_name})]", attr_text)
        if updated != attr_text:
            return updated
        # property [old]
        updated = re.sub(rf"\[{esc}\]", f"[{new_name}]", attr_text)
        if updated != attr_text:
            return updated
        # output (old)
        updated = re.sub(rf"\({esc}\)", f"({new_name})", attr_text)
        if updated != attr_text:
            return updated
        # plain attribute
        updated = re.sub(rf"\b{esc}\b", new_name, attr_text, count=1)
        if updated != attr_text:
            return updated
    return attr_text


def _collapse_attr_whitespace(text: str, removed_start: int, removed_end: int) -> tuple[str, int, int]:
    """Remove an attribute and tidy surrounding whitespace inside a tag."""
    # Prefer deleting one surrounding space so tags stay neat.
    start, end = removed_start, removed_end
    if start > 0 and text[start - 1] in " \t":
        start -= 1
    elif end < len(text) and text[end] in " \t":
        end += 1
    # If attribute sat alone on its line, drop the blank-looking indent line.
    line_start = text.rfind("\n", 0, start) + 1
    line_end = text.find("\n", end)
    if line_end < 0:
        line_end = len(text)
    before = text[line_start:start]
    after = text[end:line_end]
    if before.strip() == "" and after.strip() == "":
        # Remove whole line including its newline (prefer trailing newline).
        if line_end < len(text) and text[line_end] == "\n":
            return text[:line_start] + text[line_end + 1 :], line_start, line_end + 1
        if line_start > 0 and text[line_start - 1] == "\n":
            return text[: line_start - 1] + text[line_end:], line_start - 1, line_end
    return text[:start] + text[end:], start, end


def plan_renames(
    usages: Sequence[UsageHit],
    rename_map: dict[str, str],
) -> list[FileChangePlan]:
    by_file: dict[Path, list[UsageHit]] = defaultdict(list)
    for usage in usages:
        by_file[usage.file_path].append(usage)

    plans: list[FileChangePlan] = []
    for file_path, file_usages in sorted(by_file.items(), key=lambda item: str(item[0]).lower()):
        original = file_path.read_text(encoding="utf-8")
        # Collect binding edits with absolute spans; apply from end to start.
        edits: list[tuple[int, int, str, str]] = []  # start, end, new_attr, detail
        for usage in file_usages:
            for binding in usage.bindings:
                new_canonical = rename_map.get(binding.property_name)
                if not new_canonical:
                    continue
                # Preserve kebab style if the template used kebab for this binding.
                if "-" in binding.matched_name and "-" not in new_canonical:
                    new_template_name = camel_to_kebab(new_canonical)
                else:
                    new_template_name = new_canonical
                new_attr = _replace_name_in_attr(
                    binding.attr_text,
                    name_variants(binding.property_name) + [binding.matched_name],
                    new_template_name,
                )
                if new_attr == binding.attr_text:
                    continue
                detail = ChangeDetail(
                    line=binding.line,
                    column=binding.column,
                    message=(
                        f"{binding.kind} {binding.matched_name} → {new_template_name}"
                    ),
                )
                edits.append((binding.start, binding.end, new_attr, detail))

        if not edits:
            continue
        # Dedup overlapping identical spans.
        uniq_edits = {(s, e): (s, e, repl, detail) for s, e, repl, detail in edits}
        ordered = sorted(uniq_edits.values(), key=lambda item: item[0], reverse=True)
        updated = original
        details: list[ChangeDetail] = []
        for start, end, repl, detail in ordered:
            updated = updated[:start] + repl + updated[end:]
            details.append(detail)
        details.reverse()
        plans.append(
            FileChangePlan(
                file_path=file_path,
                repo=file_usages[0].repo,
                original=original,
                updated=updated,
                change_count=len(details),
                details=details,
            )
        )
    return plans


def plan_removals(
    usages: Sequence[UsageHit],
    input_names: Sequence[str],
    output_names: Sequence[str],
) -> list[FileChangePlan]:
    wanted = set(input_names) | set(output_names)
    by_file: dict[Path, list[UsageHit]] = defaultdict(list)
    for usage in usages:
        by_file[usage.file_path].append(usage)

    plans: list[FileChangePlan] = []
    for file_path, file_usages in sorted(by_file.items(), key=lambda item: str(item[0]).lower()):
        original = file_path.read_text(encoding="utf-8")
        removals: list[tuple[int, int, ChangeDetail]] = []
        for usage in file_usages:
            for binding in usage.bindings:
                if binding.property_name not in wanted:
                    continue
                detail = ChangeDetail(
                    line=binding.line,
                    column=binding.column,
                    message=f"remove {binding.kind} {binding.matched_name}",
                )
                removals.append((binding.start, binding.end, detail))
        if not removals:
            continue
        uniq = {(s, e): (s, e, detail) for s, e, detail in removals}
        ordered = sorted(uniq.values(), key=lambda item: item[0], reverse=True)
        updated = original
        details: list[ChangeDetail] = []
        for start, end, detail in ordered:
            updated, _, _ = _collapse_attr_whitespace(updated, start, end)
            details.append(detail)
        details.reverse()
        if updated == original:
            continue
        plans.append(
            FileChangePlan(
                file_path=file_path,
                repo=file_usages[0].repo,
                original=original,
                updated=updated,
                change_count=len(details),
                details=details,
            )
        )
    return plans


def apply_plans(plans: Sequence[FileChangePlan], apply: bool) -> None:
    if not plans:
        print(yellow("No matching bindings found — nothing to change."))
        return
    if not apply:
        print(
            yellow("DRY RUN — no files modified.")
            + " Pass "
            + bold("--apply")
            + " to write changes locally.\n"
        )
    else:
        print(green("Applying local edits…\n"))

    by_repo: dict[str, list[FileChangePlan]] = defaultdict(list)
    for plan in plans:
        by_repo[plan.repo].append(plan)

    print(bold(f"Repositories affected ({len(by_repo)}):"))
    for repo in sorted(by_repo.keys(), key=str.lower):
        repo_plans = by_repo[repo]
        files = len(repo_plans)
        changes = sum(p.change_count for p in repo_plans)
        print(f"  {cyan(repo):<40} {files} file(s), {changes} change(s)")

    print()
    print(bold(f"Files ({len(plans)}):"))
    for plan in plans:
        marker = green("updated") if apply else dim("would update")
        print(f"  [{marker}] {plan.file_path}  ({plan.change_count})")
        for detail in plan.details:
            # Keep path:line:col free of ANSI so Ctrl+Click works in Cursor/VS Code.
            link = format_clickable_path(plan.file_path, detail.line, detail.column)
            print(f"      - {link}  {dim(detail.message)}")

    if apply:
        for plan in plans:
            plan.file_path.write_text(plan.updated, encoding="utf-8", newline="")
        print()
        print(
            green(f"Wrote {len(plans)} file(s).")
            + " Review the diffs in GitHub Desktop (or git diff), then commit manually."
        )
    else:
        print()
        print(
            "Review the list above. When ready, re-run the same command with "
            + bold("--apply")
            + "."
        )


# ---------------------------------------------------------------------------
# Reporting / formatting
# ---------------------------------------------------------------------------


def format_clickable_path(path: Path, line: int, column: int = 1) -> str:
    """Absolute path with line:col — Ctrl+Clickable in VS Code / Cursor terminals."""
    return f"{path.resolve()}:{line}:{column}"


def print_find_report(
    usages: Sequence[UsageHit],
    selector: str,
    input_names: Sequence[str],
    output_names: Sequence[str],
) -> None:
    inputs_label = ", ".join(input_names) if input_names else "(none)"
    outputs_label = ", ".join(output_names) if output_names else "(none)"

    binding_count = sum(len(u.bindings) for u in usages)
    files = {u.file_path for u in usages}
    repos = {u.repo for u in usages}

    print(bold(f"Component selector: <{selector}>"))
    print(f"Inputs:  {inputs_label}")
    print(f"Outputs: {outputs_label}")
    print()

    if not usages:
        print(yellow("No matching usages found."))
        return

    if input_names or output_names:
        print(
            bold(
                f"Found {binding_count} binding(s) across {len(usages)} tag(s) "
                f"in {len(files)} file(s) / {len(repos)} repo(s)"
            )
        )
    else:
        print(
            bold(
                f"Found {len(usages)} <{selector}> usage(s) "
                f"in {len(files)} file(s) / {len(repos)} repo(s)"
            )
        )
    print()

    index = 1
    for usage in usages:
        if usage.bindings:
            for binding in usage.bindings:
                kind_label = {
                    "property": "property binding",
                    "attribute": "attribute binding",
                    "two-way": "two-way binding",
                    "output": "output binding",
                }.get(binding.kind, binding.kind)
                print(
                    f"[{index}] {bold(binding.property_name)}  "
                    + dim(f"({kind_label})")
                )
                print(f"    {format_clickable_path(usage.file_path, binding.line, binding.column)}")
                print(f"    repo: {cyan(usage.repo)}")
                for line in usage.snippet.splitlines():
                    print(dim(f"    {line}"))
                print()
                index += 1
        else:
            print(f"[{index}] {bold('<' + selector + '>')}  " + dim("(selector usage)"))
            print(
                f"    {format_clickable_path(usage.file_path, usage.tag_line, usage.tag_column)}"
            )
            print(f"    repo: {cyan(usage.repo)}")
            for line in usage.snippet.splitlines():
                print(dim(f"    {line}"))
            print()
            index += 1

    print(bold("Summary"))
    print(f"  Repositories: {len(repos)}")
    for repo in sorted(repos, key=str.lower):
        count = sum(1 for u in usages if u.repo == repo)
        print(f"    - {repo}: {count} tag(s)")
    print(f"  Files:        {len(files)}")
    print(f"  Tags:         {len(usages)}")
    if input_names or output_names:
        print(f"  Bindings:     {binding_count}")


def usages_to_markdown(
    usages: Sequence[UsageHit],
    selector: str,
    input_names: Sequence[str],
    output_names: Sequence[str],
) -> str:
    lines: list[str] = [
        f"# Angular IO usage report: `<{selector}>`",
        "",
        f"- Inputs: {', '.join(input_names) if input_names else '(none)'}",
        f"- Outputs: {', '.join(output_names) if output_names else '(none)'}",
        f"- Tags: {len(usages)}",
        f"- Files: {len({u.file_path for u in usages})}",
        f"- Repositories: {len({u.repo for u in usages})}",
        "",
    ]
    for i, usage in enumerate(usages, start=1):
        lines.append(f"## {i}. `{usage.repo}` — `{usage.file_path}`")
        lines.append("")
        lines.append(f"- Tag at line {usage.tag_line}")
        if usage.bindings:
            lines.append("- Bindings:")
            for binding in usage.bindings:
                lines.append(
                    f"  - `{binding.property_name}` ({binding.kind}) "
                    f"at {usage.file_path}:{binding.line}:{binding.column}"
                )
        lines.append("")
        lines.append("```html")
        lines.append(usage.snippet)
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


def usages_to_json(
    usages: Sequence[UsageHit],
    selector: str,
    input_names: Sequence[str],
    output_names: Sequence[str],
) -> str:
    payload = {
        "selector": selector,
        "inputs": list(input_names),
        "outputs": list(output_names),
        "usages": [
            {
                "repo": u.repo,
                "file": str(u.file_path),
                "tagLine": u.tag_line,
                "tagColumn": u.tag_column,
                "snippet": u.snippet,
                "bindings": [
                    {
                        "property": b.property_name,
                        "matchedName": b.matched_name,
                        "kind": b.kind,
                        "line": b.line,
                        "column": b.column,
                        "text": b.attr_text,
                    }
                    for b in u.bindings
                ],
            }
            for u in usages
        ],
    }
    return json.dumps(payload, indent=2)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def add_roots_arguments(target: argparse.ArgumentParser) -> None:
    target.add_argument(
        "--roots",
        nargs="+",
        metavar="PATH",
        default=[],
        help="Parent directories (or repo paths) to search. Defaults to the current working directory.",
    )
    target.add_argument(
        "--root",
        dest="roots_alias",
        action="append",
        default=[],
        metavar="PATH",
        help="Additional search root (repeatable). Same as --roots.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="angular_io_tool",
        description=(
            "Find, rename, or remove Angular component input/output bindings "
            "across HTML templates using ripgrep."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""examples:
  %(prog)s find --selector abx-icon --inputs isCustomIcon,isUtilityIcon
  %(prog)s find --selector abx-icon --inputs [isCustomIcon, isUtilityIcon] --roots D:\\repos
  %(prog)s rename --selector abx-icon --rename isCustomIcon=isCustom --apply
  %(prog)s remove --selector abx-icon --inputs isCustomIcon --apply
  %(prog)s report --selector abx-icon --inputs isCustomIcon -o report.md
""",
    )
    # Roots live on each subcommand so `find --roots PATH` works naturally.
    shared = argparse.ArgumentParser(add_help=False)
    add_roots_arguments(shared)

    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(sp: argparse.ArgumentParser, *, require_props: bool) -> None:
        sp.add_argument("--selector", required=True, help="Component selector, e.g. abx-icon")
        sp.add_argument(
            "--inputs",
            nargs="+",
            default=[],
            help="Input property names: a,b or [a, b] or a b",
        )
        sp.add_argument(
            "--outputs",
            nargs="+",
            default=[],
            help="Output property names: a,b or [a, b] or a b",
        )
        sp.set_defaults(_require_props=require_props)

    p_find = sub.add_parser(
        "find",
        parents=[shared],
        help="List usages of the component and selected bindings",
    )
    add_common(p_find, require_props=False)

    p_report = sub.add_parser(
        "report",
        parents=[shared],
        help="Write a Markdown or JSON usage report",
    )
    add_common(p_report, require_props=False)
    p_report.add_argument(
        "--format",
        choices=("markdown", "json"),
        default="markdown",
        help="Report format (default: markdown)",
    )
    p_report.add_argument("-o", "--output", help="Output file path (default: stdout)")

    p_rename = sub.add_parser(
        "rename",
        parents=[shared],
        help="Rename input/output bindings in HTML templates",
    )
    p_rename.add_argument("--selector", required=True, help="Component selector, e.g. abx-icon")
    p_rename.add_argument(
        "--rename",
        nargs="+",
        required=True,
        help="old=new pairs: a=b,c=d or [a=b, c=d]",
    )
    p_rename.add_argument(
        "--apply",
        action="store_true",
        help="Write changes to disk (default is dry-run)",
    )
    p_rename.set_defaults(_require_props=False)

    p_remove = sub.add_parser(
        "remove",
        parents=[shared],
        help="Remove input/output bindings from HTML templates",
    )
    add_common(p_remove, require_props=True)
    p_remove.add_argument(
        "--apply",
        action="store_true",
        help="Write changes to disk (default is dry-run)",
    )

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    enable_windows_ansi()
    parser = build_parser()
    args = parser.parse_args(argv)

    # Parent-level --roots are on the same namespace when using parse_args this way.
    # Subcommand --roots/--root override/extend parent-level values when both are used.
    root_args = list(getattr(args, "roots", None) or [])
    root_alias = list(getattr(args, "roots_alias", None) or [])
    roots = normalize_roots(root_args + root_alias or None)

    selector = args.selector.strip()
    if not selector:
        raise SystemExit("--selector must not be empty")
    if selector.startswith("<") and selector.endswith(">"):
        selector = selector[1:-1].strip()

    print(dim(f"Searching under {len(roots)} root(s):"))
    for root in roots:
        print(dim(f"  {root}"))
    print()

    if args.command == "rename":
        rename_map = parse_rename_map(args.rename)
        if not rename_map:
            raise SystemExit("Provide at least one --rename old=new pair")
        input_names = list(rename_map.keys())
        output_names = list(rename_map.keys())
        usages = collect_usages(selector, roots, input_names, output_names)
        # Keep bindings whose property is in the rename map.
        for usage in usages:
            usage.bindings = [b for b in usage.bindings if b.property_name in rename_map]
        usages = [u for u in usages if u.bindings]
        plans = plan_renames(usages, rename_map)
        print(
            bold("Rename plan: ")
            + ", ".join(f"{old} → {new}" for old, new in rename_map.items())
        )
        print(bold(f"Selector: <{selector}>\n"))
        apply_plans(plans, apply=bool(args.apply))
        return 0

    input_names = parse_name_list(getattr(args, "inputs", None))
    output_names = parse_name_list(getattr(args, "outputs", None))

    if getattr(args, "_require_props", False) and not input_names and not output_names:
        raise SystemExit("Provide --inputs and/or --outputs")

    usages = collect_usages(selector, roots, input_names, output_names)

    if args.command == "find":
        print_find_report(usages, selector, input_names, output_names)
        return 0

    if args.command == "report":
        if args.format == "json":
            body = usages_to_json(usages, selector, input_names, output_names)
        else:
            body = usages_to_markdown(usages, selector, input_names, output_names)
        if args.output:
            out_path = Path(args.output).expanduser().resolve()
            out_path.write_text(body, encoding="utf-8", newline="\n")
            print(green(f"Wrote report to {out_path}"))
        else:
            print(body)
        # Also print a short human summary to stderr when writing a file,
        # so the user still sees counts in the terminal.
        if args.output:
            print_find_report(usages, selector, input_names, output_names)
        return 0

    if args.command == "remove":
        plans = plan_removals(usages, input_names, output_names)
        targets = []
        if input_names:
            targets.append("inputs " + ", ".join(input_names))
        if output_names:
            targets.append("outputs " + ", ".join(output_names))
        print(bold("Remove plan: ") + "; ".join(targets))
        print(bold(f"Selector: <{selector}>\n"))
        apply_plans(plans, apply=bool(args.apply))
        return 0

    raise SystemExit(f"Unknown command: {args.command}")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
