# Angular IO Tool

Search, rename, and remove Angular component **input/output bindings** across HTML templates in one or many repositories.

The tool uses **ripgrep (`rg`)** for fast HTML search, then parses each matching opening tag so multi-line usages and camelCase / kebab-case bindings are handled correctly.

| Capability | Command | What it does |
|---|---|---|
| Find usage | `find` | Lists every matching binding with clickable file paths |
| Usage report | `report` | Writes a Markdown or JSON report |
| Rename properties | `rename` | Renames bindings in templates (dry-run by default) |
| Remove properties | `remove` | Removes bindings from templates (dry-run by default) |
| Local commit (TS) | `commit` | Creates local commits for a recorded apply-run (tool hunks only; no push/PR) |

**Scope:** HTML templates only (`.html`). It does **not** edit TypeScript `@Input()` / `@Output()` definitions.

**Matching rule:** only real attribute / binding **names** are matched — not the same text inside quoted values (e.g. `[abcd]="obj.isCustomIcon"` or `*ngIf="... == 'table'"` are ignored when searching for `isCustomIcon` / `table`).

---

## Two implementations

| | Python | TypeScript / Node |
|---|---|---|
| Path | `angular_io_tool.py` | `ts/` (compiled to `ts/dist/angular_io_tool.js`) |
| Status | Reference implementation | Port + interactive + logging + local commit |
| Interactive prompts | No | Yes |
| Run logging | No | Yes (on by default) |
| Change-run hash + `commit` | No | Yes (on `--apply`) |
| Keep until… | Parity baseline | Daily driver once trusted |

Core `find` / `report` / `rename` / `remove` flag behavior matches between both.

---

## Requirements

### Shared

- **ripgrep (`rg`)** on your `PATH`

```powershell
rg --version
```

### Python version

- **Python 3.10+**

```powershell
python --version
```

### TypeScript / Node version

- **Node.js 16+**
- npm (to install dependencies and build once)

```powershell
node --version
npm --version
```

First-time setup for the TS tool:

```powershell
cd d:\Tools\angular_attributes_renaming\ts
npm install
npm run build
```

Rebuild after pulling changes to `ts/src`:

```powershell
npm run build
```

---

## How to run

### Python

```powershell
cd d:\Tools\angular_attributes_renaming
python .\angular_io_tool.py -h
python .\angular_io_tool.py find -h
python .\angular_io_tool.py rename -h
python .\angular_io_tool.py remove -h
python .\angular_io_tool.py report -h
```

Full path form:

```powershell
python d:\Tools\angular_attributes_renaming\angular_io_tool.py find --selector abx-icon --inputs isCustomIcon --roots D:\angular-repos
```

### TypeScript / Node

```powershell
cd d:\Tools\angular_attributes_renaming\ts
node .\dist\angular_io_tool.js -h
node .\dist\angular_io_tool.js find -h
```

Full path form:

```powershell
node d:\Tools\angular_attributes_renaming\ts\dist\angular_io_tool.js find --selector abx-icon --inputs isCustomIcon --roots D:\angular-repos
```

Optional npm script (from `ts/`):

```powershell
npm run angular-io-tool -- find --selector abx-icon --inputs isCustomIcon --roots D:\angular-repos
```

---

## Shared options (Python & TypeScript)

These flags work the same on both implementations.

### `--selector` (required for non-interactive runs)

Component selector **without** angle brackets:

```powershell
--selector abx-icon
```

`<abx-icon>` is also accepted and normalized.

### `--roots` / `--root` (optional)

| Flag | Meaning |
|---|---|
| `--roots PATH [PATH ...]` | One or more parent folders or repo paths |
| `--root PATH` | Same idea, repeatable (`--root A --root B`) |
| *(omitted)* | Uses the **current working directory** |

Examples:

```powershell
# Search under one parent that contains many Angular repos
--roots D:\angular-repos

# Multiple explicit roots
--roots D:\repos\app-a D:\repos\app-b

# Repeatable --root
--root D:\repos\app-a --root D:\repos\app-b
```

Semicolon-separated paths inside a single argument are also accepted:

```powershell
--roots "D:\repos\app-a;D:\repos\app-b"
```

Skipped folders: `node_modules`, `dist`, `.angular`, `.git`, `coverage`, `tmp`, `out-tsc`, `.idea`, `.vscode`, `__pycache__`.

### `--inputs` / `--outputs`

Property names to match. Multiple forms:

```powershell
--inputs isCustomIcon,isUtilityIcon
--inputs "[isCustomIcon, isUtilityIcon]"
--inputs isCustomIcon isUtilityIcon
--inputs isCustomIcon --outputs iconClick,iconHover
```

Pass the TypeScript-style name (`isCustomIcon`); kebab-case in templates (`is-custom-icon`) is matched automatically.

### Binding forms recognized in HTML

| Kind | Examples matched |
|---|---|
| Property binding | `[isCustomIcon]="true"` |
| Attribute binding | `foregroundIcon="star"` |
| Two-way binding | `[(size)]="sz"` |
| Output binding | `(iconClick)="onClick($event)"` |
| Kebab-case | `[is-custom-icon]="..."`, `(icon-click)="..."` |

Only tags for the given `--selector` are changed.

---

## Command: `find`

Lists matching usages. Paths use absolute `file:line:column` so **Ctrl+Click** works in Cursor / VS Code.

### Python

```powershell
python .\angular_io_tool.py find `
  --selector abx-icon `
  --inputs "[isCustomIcon, isUtilityIcon]" `
  --outputs iconClick `
  --roots D:\angular-repos
```

### TypeScript

```powershell
node .\dist\angular_io_tool.js find `
  --selector abx-icon `
  --inputs "[isCustomIcon, isUtilityIcon]" `
  --outputs iconClick `
  --roots D:\angular-repos
```

**Selector only** (every `<abx-icon>` usage):

```powershell
python .\angular_io_tool.py find --selector abx-icon --roots D:\angular-repos
node .\dist\angular_io_tool.js find --selector abx-icon --roots D:\angular-repos
```

---

## Command: `report`

| Option | Values | Default |
|---|---|---|
| `--format` | `markdown`, `json` | `markdown` |
| `-o` / `--output` | file path | stdout |

### Python

```powershell
python .\angular_io_tool.py report `
  --selector abx-icon `
  --inputs isCustomIcon,isUtilityIcon `
  --format markdown `
  -o .\abx-icon-report.md `
  --roots D:\angular-repos
```

### TypeScript

```powershell
node .\dist\angular_io_tool.js report `
  --selector abx-icon `
  --inputs isCustomIcon,isUtilityIcon `
  --format json `
  -o .\usage-report.json `
  --roots D:\angular-repos
```

When `-o` is used, a human `find`-style summary is also printed in the terminal.

---

## Command: `rename`

Renames bindings in HTML. **Dry-run by default**; pass `--apply` to write.

### `--rename` forms

```powershell
--rename isCustomIcon=isCustom
--rename isCustomIcon=isCustom,isUtilityIcon=isUtility
--rename "[isCustomIcon=isCustom, isUtilityIcon=isUtility]"
```

### Python

```powershell
# Dry-run
python .\angular_io_tool.py rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos

# Apply
python .\angular_io_tool.py rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos --apply
```

### TypeScript

```powershell
node .\dist\angular_io_tool.js rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos
node .\dist\angular_io_tool.js rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos --apply
```

Each change line prints a Ctrl+Clickable `file:line:column` link. Review in GitHub Desktop, then commit manually.

---

## Command: `remove`

Removes the given input/output bindings. Requires `--inputs` and/or `--outputs`. Dry-run by default; `--apply` writes.

### Python

```powershell
python .\angular_io_tool.py remove --selector abx-icon --inputs isUtilityIcon --roots D:\angular-repos
python .\angular_io_tool.py remove --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]" --roots D:\angular-repos --apply
```

### TypeScript

```powershell
node .\dist\angular_io_tool.js remove --selector abx-icon --inputs isUtilityIcon --roots D:\angular-repos
node .\dist\angular_io_tool.js remove --selector abx-icon --outputs iconClick --roots D:\angular-repos --apply
```

---

## TypeScript-only: interactive prompts

You do **not** need to remember every flag. The TS tool prompts when required values are missing.

### Ways to start interactive mode

```powershell
cd d:\Tools\angular_attributes_renaming\ts

# Top-level menu (find / report / rename / remove / commit / quit)
node .\dist\angular_io_tool.js

# Wizard for one command (asks for missing fields)
node .\dist\angular_io_tool.js find
node .\dist\angular_io_tool.js report
node .\dist\angular_io_tool.js rename
node .\dist\angular_io_tool.js remove
node .\dist\angular_io_tool.js commit

# Force prompts even if some flags are present
node .\dist\angular_io_tool.js find --interactive
node .\dist\angular_io_tool.js find -i --selector abx-icon
```

### What each wizard asks

| Command | Prompts (in order) |
|---|---|
| `find` | selector → inputs → outputs → roots → confirm |
| `report` | selector → inputs → outputs → format → output file → roots → confirm |
| `rename` | selector → rename pairs (`old=new`) → roots → apply? → confirm |
| `remove` | selector → inputs → outputs → roots → apply? → confirm |
| `commit` | hash → branch-name → target-branch → title → body → confirm |

- Press **Enter** to accept defaults (e.g. roots = current directory, apply = no / dry-run).
- Type **`q`** to cancel.
- Full CLI flags still work with **no prompts** when required options are provided.

### After a dry-run (interactive rename/remove)

If you started interactively and chose dry-run, the tool can ask:

```text
Dry-run complete. Apply these changes now? [y/N]
```

---

## TypeScript-only: run logging

Every TS run writes a log (unless disabled) so you can track which repos/files were touched.

| Option | Meaning |
|---|---|
| *(default)* | Writes `d:\Tools\angular_attributes_renaming\logs\run-<timestamp>.log` |
| `--log PATH` | Write that specific log file |
| `--no-log` | Disable logging for this run |

Log contents include:

- timestamp and command
- selector / inputs / outputs / rename / apply
- roots
- repos and files affected
- change-run hash (after `--apply`)
- local commit repo/branch/sha summary (after `commit`)
- full console transcript (ANSI stripped)

Example:

```powershell
node .\dist\angular_io_tool.js rename `
  --selector abx-icon `
  --rename isCustomIcon=isCustom `
  --roots D:\angular-repos `
  --log D:\Tools\angular_attributes_renaming\logs\my-rename.log
```

---

## TypeScript-only: change runs + `commit`

When `rename` / `remove` runs with **`--apply`**, the tool records a **change-run hash** under:

```text
d:\Tools\angular_attributes_renaming\logs\runs\<hash>.json
d:\Tools\angular_attributes_renaming\logs\runs\index.json
```

Each run stores per-repo file snapshots (`before` / `after`) so `commit` can stage **only the tool hunks**, even if the working tree has other local edits.

`commit` is **local only** — it does **not** push or open PRs, and does **not** need `GIT_ACCESS_TOKEN`. Push/PR are left to you (or a separate tool).

### Commit command

```powershell
$tool = "d:\Tools\angular_attributes_renaming\ts\dist\angular_io_tool.js"

# Interactive
node $tool commit

# Flags
node $tool commit <hash> `
  --branch-name feature/rename-isCustomIcon `
  --target-branch qa `
  --title "refactor(abx-icon): rename isCustomIcon to isCustom" `
  --body "Automated template binding rename across consumers."
```

What `commit` does per affected repo:

1. **Stash** local dirty changes (so rename `--apply` worktrees do not block checkout)
2. Resolve `--target-branch` (local or `origin/<target>` when available)
3. Create / reset `--branch-name` from that target
4. Apply **only** the recorded tool patches and stage those files
5. Create a **local** commit with the same title/body in every repo
6. Restore your previous branch and stash
7. Print **repo name**, **branch name**, and **commit sha**

You can reuse an existing change-run hash after `--apply` — you do not need to re-rename first.

Then push/open PRs yourself, e.g.:

```powershell
cd <repo>
git checkout bugfix/rename-fillColor
git push -u origin HEAD
```

---

## Typical end-to-end flow

### Python (flag-based)

```powershell
$tool = "d:\Tools\angular_attributes_renaming\angular_io_tool.py"
$roots = "D:\angular-repos"

python $tool find --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]" --roots $roots
python $tool rename --selector abx-icon --rename isCustomIcon=isCustom --roots $roots
python $tool rename --selector abx-icon --rename isCustomIcon=isCustom --roots $roots --apply
# Review in GitHub Desktop, commit manually
```

### TypeScript (interactive or flags + commit)

```powershell
$tool = "d:\Tools\angular_attributes_renaming\ts\dist\angular_io_tool.js"
$roots = "D:\angular-repos"

node $tool find --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]" --roots $roots
node $tool rename --selector abx-icon --rename isCustomIcon=isCustom --roots $roots --apply
# Note the printed change-run hash, then:
node $tool commit <hash> --branch-name feature/rename-icon --target-branch qa --title "rename isCustomIcon"
# then push / open PRs yourself using the printed repo + branch list
```

---

## Output & review tips

### Clickable paths

```text
D:\orektic\products\my-app\src\app\header\header.component.html:18:3
```

Ctrl+Click in the Cursor/VS Code terminal. Used by `find`, `report` summaries, and each `rename` / `remove` change line.

### Repository labels

Grouped by project/repo under your `--roots` (or git toplevel when applicable) so you can open the right repo in GitHub Desktop.

### Dry-run vs `--apply`

| Mode | Behavior |
|---|---|
| Default (no `--apply`) | Preview only |
| `--apply` | Writes HTML files on disk |

No automatic git commit, branch, or PR.

### Environment

- Set `NO_COLOR=1` to disable colored terminal output.

---

## Parity checking (Python vs TypeScript)

While validating the TS port, run the same command on both and compare counts / file edits, e.g. against `_fixture`:

```powershell
$fix = "d:\Tools\angular_attributes_renaming\_fixture"
$args = @("find","--roots",$fix,"--selector","abx-icon","--inputs","isCustomIcon,isUtilityIcon")

python d:\Tools\angular_attributes_renaming\angular_io_tool.py @args
node d:\Tools\angular_attributes_renaming\ts\dist\angular_io_tool.js @args --no-log
```

---

## What this tool does *not* do

- Does not modify `.ts` / `.js` component class files (`@Input`, `@Output`, aliases)
- Does not rename the component selector itself
- Does not create git branches, commits, or pull requests
- Does not search inside skipped build folders (`node_modules`, `dist`, etc.)

After renaming template bindings, update the component TypeScript definitions separately if those API names are changing too.

---

## Quick reference

### Python

```text
python angular_io_tool.py find   --selector SEL [--inputs ...] [--outputs ...] [--roots ...]
python angular_io_tool.py report --selector SEL [--inputs ...] [--outputs ...] [--format markdown|json] [-o FILE] [--roots ...]
python angular_io_tool.py rename --selector SEL --rename old=new[,...] [--apply] [--roots ...]
python angular_io_tool.py remove --selector SEL (--inputs ... | --outputs ...) [--apply] [--roots ...]
```

### TypeScript

```text
node dist/angular_io_tool.js                          # interactive menu
node dist/angular_io_tool.js find                     # interactive find
node dist/angular_io_tool.js find   --selector SEL [--inputs ...] [--outputs ...] [--roots ...] [--log PATH] [--no-log]
node dist/angular_io_tool.js report --selector SEL [--format markdown|json] [-o FILE] [--roots ...]
node dist/angular_io_tool.js rename --selector SEL --rename old=new[,...] [--apply] [--roots ...]
node dist/angular_io_tool.js remove --selector SEL (--inputs ... | --outputs ...) [--apply] [--roots ...]
node dist/angular_io_tool.js commit [HASH] --branch-name NAME --target-branch BASE --title TEXT [--body TEXT]
```
