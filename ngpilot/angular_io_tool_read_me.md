# ngpilot

Multi-repository Angular template tooling: **find**, **report**, **rename**, and **remove** component input/output bindings in HTML, then optionally create **local commits** from a recorded apply run.

The CLI binary is **`ngpilot`** (`ts/dist/angular_io_tool.js`). It uses **ripgrep (`rg`)** for fast HTML search, then parses each matching opening tag so multi-line usages and camelCase / kebab-case bindings are handled correctly.

| Capability | Command | What it does |
|---|---|---|
| Find usage | `find` | Lists every matching binding with clickable file paths |
| Usage report | `report` | Writes a Markdown or JSON report |
| Rename properties | `rename` | Renames bindings in templates (dry-run by default) |
| Remove properties | `remove` | Removes bindings from templates (dry-run by default) |
| Local commit | `commit` | Creates local commits for a recorded apply-run (tool hunks only; no push/PR) |
| Impact tracking | (on `--apply`) | Appends per-binding rows to centralized JSON + CSV logs |

**Scope:** HTML templates only (`.html`). It does **not** edit TypeScript `@Input()` / `@Output()` definitions.

**Matching rule:** only real attribute / binding **names** are matched — not the same text inside quoted values (e.g. `[abcd]="obj.isCustomIcon"` or `*ngIf="... == 'table'"` are ignored when searching for `isCustomIcon` / `table`).

A legacy Python reference (`angular_io_tool.py`) remains in the repo for parity on find/report/rename/remove only. New features (interactive config, impact logs, local commit, env/user config) are **TypeScript / ngpilot only**.

---

## Requirements

- **ripgrep (`rg`)** on your `PATH`
- **Node.js 16+** and npm

```powershell
rg --version
node --version
npm --version
```

First-time setup:

```powershell
cd d:\Tools\ngpilot\ts
npm install
npm run build
```

Install the CLI locally (optional):

```powershell
npm link
ngpilot --help
```

Or run without linking:

```powershell
node .\dist\angular_io_tool.js --help
npm run ngpilot -- --help
```

---

## Configuration resolution

For roots, logs directory, runs directory, impact log path, and GitHub username, ngpilot resolves values in this order (highest first):

1. **CLI flag** (also **updates** saved user config)
2. **Environment variable** (overrides saved config; does **not** rewrite it)
3. **Saved user config** — `%USERPROFILE%\.ngpilot\config.json`
4. **Interactive prompt** (only when still unset; answer is saved)
5. **Built-in defaults** under the installed tool root (`ngpilot/logs/...`)

### Environment variables

| Variable | Purpose | Format / example |
|---|---|---|
| `NGPILOT_ROOTS` | Repository search roots | `;`-separated paths |
| `NGPILOT_LOGS` | Directory for `run-*.log` transcripts | Absolute directory |
| `NGPILOT_RUNS` | Directory for change-run JSON files | Absolute directory |
| `NGPILOT_IMPACT_LOG` | Impact log file (JSON+CSV sibling pair) | Absolute file path |
| `NGPILOT_GITHUB_USER` | GitHub username for impact rows | String |
| `GITHUB_USER` | Fallback if `NGPILOT_GITHUB_USER` unset | String |

If only `NGPILOT_LOGS` is set:

- runs default to `$NGPILOT_LOGS\runs`
- impact defaults to `$NGPILOT_LOGS\components_impact_area.{json,csv}`

### Shell examples (PowerShell)

Session-only:

```powershell
$env:NGPILOT_ROOTS = "D:\angular-repos;D:\other-repos"
$env:NGPILOT_LOGS = "D:\ngpilot-data\logs"
$env:NGPILOT_RUNS = "D:\ngpilot-data\logs\runs"
$env:NGPILOT_IMPACT_LOG = "D:\folder\nested\their_file_name.csv"
$env:NGPILOT_GITHUB_USER = "your-github-login"
```

User-wide (survives new terminals):

```powershell
[System.Environment]::SetEnvironmentVariable("NGPILOT_ROOTS", "D:\angular-repos", "User")
[System.Environment]::SetEnvironmentVariable("NGPILOT_IMPACT_LOG", "D:\folder\nested\their_file_name.csv", "User")
[System.Environment]::SetEnvironmentVariable("NGPILOT_GITHUB_USER", "your-github-login", "User")
```

Open a **new** terminal after setting User-level variables.

### Saved user config

Path: `%USERPROFILE%\.ngpilot\config.json`

Example:

```json
{
  "roots": ["D:\\angular-repos"],
  "logsDir": "D:\\ngpilot-data\\logs",
  "runsDir": "D:\\ngpilot-data\\logs\\runs",
  "impactLog": "D:\\folder\\nested\\their_file_name.csv",
  "githubUserName": "your-github-login"
}
```

Interactive answers are stored here once. Change them later with CLI flags (which update this file) or by editing the JSON.

### Default locations (tool install root)

Relative to the `ngpilot` package root (not your cwd):

| Artifact | Default |
|---|---|
| Run transcripts | `logs/run-<timestamp>.log` |
| Change runs | `logs/runs/<hash>.json` |
| Impact JSON | `logs/components_impact_area.json` |
| Impact CSV | `logs/components_impact_area.csv` |

After a successful `--apply`, the tool prints the resolved impact JSON and CSV paths.

---

## CLI help

```powershell
ngpilot --help
ngpilot rename --help
ngpilot remove --help
ngpilot find --help
ngpilot report --help
ngpilot commit --help
```

Main and command help include the configuration priority, environment variables, and PowerShell examples.

---

## Shared options

### `--selector`

Component selector **without** angle brackets (`abx-icon`). `<abx-icon>` is accepted and normalized.

### `--roots` / `--root`

| Flag | Meaning |
|---|---|
| `--roots PATH [PATH ...]` | One or more parent folders or repo paths (saved to user config) |
| `--root PATH` | Repeatable extra root |
| *(omitted)* | `NGPILOT_ROOTS` → saved config → interactive → **cwd** |

```powershell
--roots D:\angular-repos
--roots D:\repos\app-a D:\repos\app-b
--roots "D:\repos\app-a;D:\repos\app-b"
```

When `NGPILOT_ROOTS` (or saved roots) is set, interactive mode does **not** ask for roots again.

### Path / logging options

| Flag | Meaning |
|---|---|
| `--logs-dir <path>` | Directory for `run-*.log` (overrides `NGPILOT_LOGS`; saved) |
| `--runs-dir <path>` | Directory for change-run JSON (overrides `NGPILOT_RUNS`; saved) |
| `--impact-log <path>` | Impact `.csv` / `.json` / base path (sibling pair; overrides `NGPILOT_IMPACT_LOG`; saved) |
| `--log <path>` | Write **this run's** transcript to a specific file |
| `--no-log` | Disable run transcript logging |
| `-i` / `--interactive` | Force prompts |

**Impact log siblings:** if you pass `D:\folder\nested\their_file_name.csv`, JSON is written to `D:\folder\nested\their_file_name.json` (and the reverse). Missing directories are created.

### `--inputs` / `--outputs`

```powershell
--inputs isCustomIcon,isUtilityIcon
--inputs "[isCustomIcon, isUtilityIcon]"
--inputs isCustomIcon isUtilityIcon
--inputs isCustomIcon --outputs iconClick,iconHover
```

Pass the TypeScript-style name (`isCustomIcon`); kebab-case in templates is matched automatically.

### Binding forms recognized

| Kind | Examples |
|---|---|
| Property binding | `[isCustomIcon]="true"` |
| Attribute binding | `foregroundIcon="star"` |
| Two-way binding | `[(size)]="sz"` |
| Output binding | `(iconClick)="onClick($event)"` |
| Kebab-case | `[is-custom-icon]="..."`, `(icon-click)="..."` |

---

## Commands

### `find`

```powershell
ngpilot find --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]" --outputs iconClick --roots D:\angular-repos
ngpilot find --selector abx-icon
```

Paths print as absolute `file:line:column` for **Ctrl+Click**.

### `report`

| Option | Values | Default |
|---|---|---|
| `--format` | `markdown`, `json` | `markdown` |
| `-o` / `--output` | file path | stdout |

```powershell
ngpilot report --selector abx-icon --inputs isCustomIcon --format markdown -o .\abx-icon-report.md --roots D:\angular-repos
```

### `rename`

Dry-run by default; `--apply` writes files.

```powershell
ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos
ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos --apply
ngpilot rename --selector abx-icon --rename fillColor=foregroundColor --apply --impact-log D:\folder\nested\their_file_name.csv
```

`--rename` forms:

```powershell
--rename isCustomIcon=isCustom
--rename isCustomIcon=isCustom,isUtilityIcon=isUtility
--rename "[isCustomIcon=isCustom, isUtilityIcon=isUtility]"
```

### `remove`

Requires `--inputs` and/or `--outputs`. Dry-run by default; `--apply` writes.

```powershell
ngpilot remove --selector abx-icon --inputs isUtilityIcon --roots D:\angular-repos
ngpilot remove --selector abx-icon --inputs isUtilityIcon --roots D:\angular-repos --apply
```

### `commit` (local only)

Creates local feature-branch commits from a recorded `--apply` change-run hash. **No push, no PR, no token.**

```powershell
ngpilot commit
ngpilot commit <hash> --branch-name feature/rename-icon --target-branch qa --title "rename isCustomIcon" --body "..."
```

Per repo: stash → resolve target → create/reset feature branch from target (existing local branch is hard-reset to target) → apply tool hunks only → local commit → restore previous branch/stash → print repo / branch / sha.

---

## Interactive mode

```powershell
ngpilot
ngpilot -i
ngpilot rename -i
```

| Command | Prompts |
|---|---|
| `find` | selector → inputs → outputs → roots (if unset) → logs/runs dirs (if unset) → confirm |
| `report` | selector → inputs → outputs → format → output → roots → logs/runs → confirm |
| `rename` | selector → rename pairs → roots → apply? → logs/runs/impact (if unset) → confirm |
| `remove` | selector → inputs/outputs → roots → apply? → logs/runs/impact (if unset) → confirm |
| `commit` | hash → branch-name → target-branch → title → body → confirm |

Enter accepts defaults. After a dry-run in interactive rename/remove, you can choose to apply immediately.

---

## Impact area logging (`rename` / `remove` + `--apply`)

On every successful apply, ngpilot appends **one record per individual binding change** (two renames on the same line → two rows).

| Field | Description |
|---|---|
| `id` | UUIDv7 per record |
| `github-user-name` | See resolution below |
| `timestamp` | ISO-8601 time of the apply |
| `selector` | Component selector you searched (e.g. `abx-icon`) |
| `operation-name` | `rename` or `remove` |
| `attribute-affected` | Attribute name (e.g. `fillColor`) |
| `notes` | e.g. `Renamed fillColor to foregroundColor`, `Removed isCustomIcon` |
| `repository-affected` | Repo label (e.g. `components-base-v1`) |
| `component-affected` | Owning component selector (see below) |
| `file/line-affected` | `D:\...\file.html:42` |

### GitHub username resolution

1. `NGPILOT_GITHUB_USER` / `GITHUB_USER`
2. Saved config `githubUserName`
3. `gh api user -q .login` (if `gh` is logged in) — then saved
4. Interactive prompt (TTY) — then saved
5. `git config user.name` (not necessarily a GitHub login)
6. Empty string

### `component-affected` resolution

1. Nearby `.ts` with `templateUrl` pointing at the HTML (same folder, including `*.component.ts`)
2. Else same-stem siblings (`abx-table.html` → `abx-table.ts` / `abx-table.component.ts`)
3. `@Component` `selector: 'literal'` **or** same-file `const` string (e.g. `$COMPONENT_NAME`)
4. Else HTML stem (`abx-table.html` → `abx-table`)
5. Else empty (imported selectors are not followed)

Dry-runs do **not** write impact records.

---

## Change runs + local commit

When `rename` / `remove` runs with **`--apply`**, a **change-run hash** is stored under the configured runs directory (default `logs/runs/`).

Each run stores per-repo file snapshots (`before` / `after`) so `commit` can stage **only the tool hunks**, even if the working tree has other local edits.

```powershell
ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom --roots D:\angular-repos --apply
# note the printed hash
ngpilot commit <hash> --branch-name feature/rename-icon --target-branch qa --title "rename isCustomIcon"
# then push / open PRs yourself
```

---

## Run logging

Every command writes a transcript by default (ANSI stripped) under the logs directory, unless `--no-log` or a custom `--log <file>` is used.

Logged metadata includes command, selector, roots, apply flag, change-run hash, and impacted files.

---

## Typical workflow

```powershell
$env:NGPILOT_ROOTS = "D:\angular-repos"
$env:NGPILOT_GITHUB_USER = "your-github-login"

ngpilot find --selector abx-icon --inputs "[isCustomIcon, isUtilityIcon]"
ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom
ngpilot rename --selector abx-icon --rename isCustomIcon=isCustom --apply
# Review impact JSON/CSV paths printed by the tool
ngpilot commit <hash> --branch-name feature/rename-icon --target-branch qa --title "rename isCustomIcon"
```

---

## Behavior notes

### Grouping

Results are grouped by project/repo under your roots (or git toplevel when applicable).

### Dry-run vs `--apply`

| Mode | Behavior |
|---|---|
| Default (no `--apply`) | Preview only |
| `--apply` | Writes HTML, records change-run, appends impact rows |

### Existing local feature branch on `commit`

If `--branch-name` already exists locally, ngpilot checks it out and **hard-resets it to `--target-branch`** before applying tool hunks — prior commits on that feature branch are discarded.

### Patch isolation on `commit`

For each file, ngpilot builds the feature-branch content in this order:

1. Exact match of apply-time `before` / already-applied `after` on the target tip  
2. Hardened unified patch (`before` → `after` onto target tip, multiple context/fuzz levels)  
3. **Semantic re-apply** of the recorded rename/remove onto the target-tip HTML (preserves unrelated tip edits)  
4. Last resort: write the apply-time `after` snapshot (warning printed; review the PR)

After a **successful** local commit, ngpilot returns to your previous branch and **discards** the tool-touched files there (they live on `--branch-name` now). Unrelated local changes from the stash are kept. If commit fails for a repo, apply-time file contents are restored.

---

## Limitations

- Does not modify `.ts` / `.js` component class files (`@Input`, `@Output`, aliases)
- Does not rename the component selector itself
- Does not push remotes or open pull requests
- Impact `component-affected` does not resolve selectors imported from other files

After renaming template bindings, update the component TypeScript definitions separately if those API names are changing too.

---

## Quick reference

```text
ngpilot find   --selector SEL [--inputs ...] [--outputs ...] [--roots ...]
ngpilot report --selector SEL [--format markdown|json] [-o FILE] [--roots ...]
ngpilot rename --selector SEL --rename old=new[,...] [--apply] [--impact-log PATH] [--roots ...]
ngpilot remove --selector SEL (--inputs ... | --outputs ...) [--apply] [--impact-log PATH] [--roots ...]
ngpilot commit [HASH] --branch-name NAME --target-branch BASE --title TEXT [--body TEXT]

Shared: [--logs-dir DIR] [--runs-dir DIR] [--log FILE] [--no-log] [-i]
```

---

## Tests

```powershell
cd d:\Tools\ngpilot\ts
npm test
```

Runs local-commit fixture tests plus impact/config/help tests.
