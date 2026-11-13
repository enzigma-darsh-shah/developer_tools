# Angular IO Tool

Search, rename, and remove Angular component **input/output bindings** across HTML templates in one or many repositories.

The tool uses **ripgrep (`rg`)** for fast HTML search, then parses each matching opening tag so multi-line usages and camelCase / kebab-case bindings are handled correctly.

| Capability | Command | What it does |
|---|---|---|
| Find usage | `find` | Lists every matching binding with clickable file paths |
| Usage report | `report` | Writes a Markdown or JSON report |
| Rename properties | `rename` | Renames bindings in templates (dry-run by default) |
| Remove properties | `remove` | Removes bindings from templates (dry-run by default) |

**Scope:** HTML templates only (`.html`). It does **not** edit TypeScript `@Input()` / `@Output()` definitions. Mutations only change local files — no branches or PRs are created. Review diffs in GitHub Desktop (or `git diff`) and commit manually.

---

## Requirements

- **Python 3.10+** (3.14 is fine)
- **ripgrep (`rg`)** on your `PATH`

Check:

```powershell
python --version
rg --version
```

---

## Location & how to run

Script path:

```text
d:\Tools\angular_attributes_renaming\angular_io_tool.py
```

Run with Python (PowerShell examples below). You can also `cd` into the folder first:

```powershell
cd d:\Tools\angular_attributes_renaming
python .\angular_io_tool.py -h
```

Built-in help:

```powershell
python .\angular_io_tool.py -h
python .\angular_io_tool.py find -h
python .\angular_io_tool.py rename -h
python .\angular_io_tool.py remove -h
python .\angular_io_tool.py report -h
```

---

## Shared options (all commands)

### `--selector` (required)

Component selector **without** angle brackets:

```powershell
--selector abx-icon
```

`<abx-icon>` is also accepted and normalized.

### `--roots` / `--root` (optional)

Where to search:

| Flag | Meaning |
|---|---|
| `--roots PATH [PATH ...]` | One or more parent folders or repo paths |
| `--root PATH` | Same idea, repeatable (`--root A --root B`) |
| *(omitted)* | Uses the **current working directory** |

Examples:

```powershell
# Search under one parent that contains many Angular repos
python .\angular_io_tool.py find --selector abx-icon --inputs isCustomIcon --roots D:\angular-repos

# Search multiple explicit roots
python .\angular_io_tool.py find --selector abx-icon --inputs isCustomIcon --roots D:\repos\app-a D:\repos\app-b

# Repeatable --root
python .\angular_io_tool.py find --selector abx-icon --inputs isCustomIcon --root D:\repos\app-a --root D:\repos\app-b

# No --roots → search from wherever you ran the command
cd D:\angular-repos
python d:\Tools\angular_attributes_renaming\angular_io_tool.py find --selector abx-icon --inputs isCustomIcon
```

Semicolon-separated paths inside a single argument are also accepted (useful in some scripts):

```powershell
--roots "D:\repos\app-a;D:\repos\app-b"
```

Skipped folders during search include: `node_modules`, `dist`, `.angular`, `.git`, `coverage`, `tmp`, `out-tsc`, `.idea`, `.vscode`, `__pycache__`.

### `--inputs` / `--outputs` (optional on `find` / `report`; required on `remove`)

Property names to match. You can pass **multiple** inputs/outputs in several equivalent forms:

```powershell
# Comma-separated
--inputs isCustomIcon,isUtilityIcon

# Bracket list (quote it in PowerShell so [] is not interpreted)
--inputs "[isCustomIcon, isUtilityIcon]"

# Space-separated
--inputs isCustomIcon isUtilityIcon

# Mix with outputs
--inputs isCustomIcon --outputs iconClick,iconHover
--outputs "[iconClick, iconHover]"
```

**Naming:** pass the TypeScript-style name (`isCustomIcon`). The tool also matches the kebab-case template form (`is-custom-icon`).

### Binding forms recognized in HTML

| Kind | Examples matched |
|---|---|
| Property binding | `[isCustomIcon]="true"` |
| Attribute binding | `foregroundIcon="star"` |
| Two-way binding | `[(size)]="sz"` |
| Output binding | `(iconClick)="onClick($event)"` |
| Kebab-case | `[is-custom-icon]="..."`, `(icon-click)="..."` |

Only tags for the given `--selector` are changed. The same property name on a different component is left alone.

---

## Command: `find`

Lists matching usages in the terminal. Paths are printed as:

```text
D:\full\path\to\file.component.html:42:5
```

In **Cursor / VS Code**, **Ctrl+Click** (or Cmd+Click on macOS) that path to open the file at the line.

### Examples

**Multiple inputs on the same component:**

```powershell
python .\angular_io_tool.py find `
  --selector abx-icon `
  --inputs "[isCustomIcon, isUtilityIcon]" `
  --roots D:\angular-repos
```

**Inputs and outputs together:**

```powershell
python .\angular_io_tool.py find `
  --selector abx-icon `
  --inputs isCustomIcon,isUtilityIcon `
  --outputs iconClick `
  --roots D:\angular-repos
```

**Selector only** (every `<abx-icon>` usage, no property filter):

```powershell
python .\angular_io_tool.py find --selector abx-icon --roots D:\angular-repos
```

### What the output includes

- Component selector and the inputs/outputs you asked for
- Numbered hits with binding kind (property / attribute / two-way / output)
- Absolute clickable `file:line:column` paths
- Repository / project label
- A short HTML snippet around the tag
- Summary: repos, files, tags, bindings

---

## Command: `report`

Same search as `find`, but writes a durable report.

| Option | Values | Default |
|---|---|---|
| `--format` | `markdown`, `json` | `markdown` |
| `-o` / `--output` | file path | stdout (prints the report) |

### Examples

**Markdown file:**

```powershell
python .\angular_io_tool.py report `
  --selector abx-icon `
  --inputs isCustomIcon,isUtilityIcon `
  --format markdown `
  -o D:\Tools\angular_attributes_renaming\abx-icon-report.md `
  --roots D:\angular-repos
```

**JSON file:**

```powershell
python .\angular_io_tool.py report `
  --selector abx-icon `
  --inputs isCustomIcon `
  --outputs iconClick `
  --format json `
  -o .\usage-report.json `
  --roots D:\angular-repos
```

**Print Markdown to the terminal:**

```powershell
python .\angular_io_tool.py report --selector abx-icon --inputs isCustomIcon --roots D:\angular-repos
```

When `-o` is used, the tool also prints the human-friendly `find`-style summary in the terminal so you still see counts and clickable paths.

---

## Command: `rename`

Renames input/output binding names in HTML for the given selector.

**Safety:** default is a **dry run** (no files written). Pass `--apply` to write local edits.

### `--rename` forms

```powershell
--rename isCustomIcon=isCustom
--rename isCustomIcon=isCustom,isUtilityIcon=isUtility
--rename "[isCustomIcon=isCustom, isUtilityIcon=isUtility]"
--rename isCustomIcon=isCustom isUtilityIcon=isUtility
```

If a template used kebab-case (`[is-custom-icon]`), the replacement is written in kebab-case when the new name is camelCase (e.g. `isCustom` → `is-custom`).

### Recommended workflow

1. Dry-run and review the affected repos/files list  
2. Apply  
3. Review diffs in GitHub Desktop  
4. Commit manually per repo  

```powershell
# 1) Dry-run
python .\angular_io_tool.py rename `
  --selector abx-icon `
  --rename isCustomIcon=isCustom `
  --roots D:\angular-repos

# 2) Apply locally
python .\angular_io_tool.py rename `
  --selector abx-icon `
  --rename isCustomIcon=isCustom `
  --roots D:\angular-repos `
  --apply
```

**Multiple renames in one pass:**

```powershell
python .\angular_io_tool.py rename `
  --selector abx-icon `
  --rename "[isCustomIcon=isCustom, isUtilityIcon=isUtility]" `
  --roots D:\angular-repos `
  --apply
```

### What the output includes

- Rename plan (`old → new`)
- Whether it is a dry run or applying
- **Repositories affected** (name, file count, change count)
- **Files** with absolute paths and per-change details
- Each change line uses a Ctrl+Clickable `file:line:column` link (same as `find`)
- Reminder to review in GitHub Desktop / `git diff` before committing

---

## Command: `remove`

Removes the specified input and/or output bindings from matching component tags.

**Requires** at least one of `--inputs` or `--outputs`.

**Safety:** dry-run by default; pass `--apply` to write.

### Examples

```powershell
# Dry-run: remove one input
python .\angular_io_tool.py remove `
  --selector abx-icon `
  --inputs isUtilityIcon `
  --roots D:\angular-repos

# Remove multiple inputs
python .\angular_io_tool.py remove `
  --selector abx-icon `
  --inputs "[isCustomIcon, isUtilityIcon]" `
  --roots D:\angular-repos `
  --apply

# Remove an output binding
python .\angular_io_tool.py remove `
  --selector abx-icon `
  --outputs iconClick `
  --roots D:\angular-repos `
  --apply

# Inputs and outputs together
python .\angular_io_tool.py remove `
  --selector abx-icon `
  --inputs isCustomIcon `
  --outputs iconClick `
  --roots D:\angular-repos `
  --apply
```

Surrounding whitespace / empty attribute lines are cleaned up when an attribute is removed.

---

## Typical end-to-end flow

```powershell
$tool = "d:\Tools\angular_attributes_renaming\angular_io_tool.py"
$roots = "D:\angular-repos"

# 1. Discover where a property is used (Ctrl+Click paths in the terminal)
python $tool find --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]" --roots $roots

# 2. Optional durable report for sharing / tickets
python $tool report --selector abx-icon --inputs isCustomIcon,isUtilityIcon -o .\abx-icon-inputs.md --roots $roots

# 3. Preview a rename
python $tool rename --selector abx-icon --rename isCustomIcon=isCustom --roots $roots

# 4. Apply the rename locally
python $tool rename --selector abx-icon --rename isCustomIcon=isCustom --roots $roots --apply

# 5. Open GitHub Desktop, review each affected repo, commit manually
```

---

## Output & review tips

### Clickable paths (`find` / `report` summary / `rename` / `remove`)

Paths look like:

```text
D:\orektic\products\my-app\src\app\header\header.component.html:18:3
```

Ctrl+Click in the Cursor/VS Code terminal to jump to that location.  
`rename` and `remove` print the same `file:line:column` form on each change detail line.

### Repository labels (`rename` / `remove`)

The tool groups changes by a project/repo label so you can open the right repo in GitHub Desktop. Labels prefer:

1. A git repository that lives under your `--roots` path, or  
2. The first folder under `--roots` (when searching a parent of many projects)

### Dry-run vs `--apply`

| Mode | Behavior |
|---|---|
| Default (no `--apply`) | Prints what **would** change; writes nothing |
| `--apply` | Writes HTML files on disk only |

There is no automatic git commit, branch, or PR.

### Environment

- Set `NO_COLOR=1` to disable colored terminal output.

---

## What this tool does *not* do

- Does not modify `.ts` / `.js` component class files (`@Input`, `@Output`, aliases)
- Does not rename the component selector itself
- Does not create git branches, commits, or pull requests
- Does not search inside skipped build folders (`node_modules`, `dist`, etc.)

After renaming template bindings, update the component TypeScript definitions separately if those API names are changing too.

---

## Quick reference

```text
python angular_io_tool.py find   --selector SEL [--inputs ...] [--outputs ...] [--roots ...]
python angular_io_tool.py report --selector SEL [--inputs ...] [--outputs ...] [--format markdown|json] [-o FILE] [--roots ...]
python angular_io_tool.py rename --selector SEL --rename old=new[,...] [--apply] [--roots ...]
python angular_io_tool.py remove --selector SEL (--inputs ... | --outputs ...) [--apply] [--roots ...]
```
