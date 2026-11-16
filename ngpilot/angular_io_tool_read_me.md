# ngpilot

# Index
- [Installation guide](#installation-guide)
- [Requirements](#requirements)
- [Configuration resolution](#configuration-resolution)
- [CLI help](#cli-help)
- [Shared Options](#shared-options)
- [Commands](#commands)
- [Interactive Mode](#interactive-mode)
- [Impact Area Logging](#impact-area-logging)
- [Change Runs](#change-runs)
- [Typical Workflow](#typical-workflow)
- [Behaviour Notes](#behaviour-notes)
- [Limitations](#limitations)
- [Quick Reference](#quick-reference)

Multi-repository Angular template tooling: **find**, **report**, **rename**, **remove**, **remove-unused**, and **fix-io-names** for component input/output bindings, then optionally create **local commits** from recorded apply runs.

The CLI binary is **`ngpilot`** (`ts/dist/angular_io_tool.js`). It uses **ripgrep (`rg`)** for fast HTML search, then parses each matching opening tag so multi-line usages and camelCase / kebab-case bindings are handled correctly.

| Capability | Command | What it does |
|---|---|---|
| Find usage | `find` | Lists every matching binding with clickable file paths |
| Usage report | `report` | Writes a Markdown or JSON report |
| Rename properties | `rename` | Renames bindings in templates (dry-run by default) |
| Remove properties | `remove` | Removes bindings from templates (dry-run by default) |
| Remove unused APIs | `remove-unused` | Audits `@Input`/`@Output`, prompts per unused attr, removes HTML + TS |
| Fix I/O names | `fix-io-names` | Audits naming standards, prompts per violation, renames HTML + TS |
| Local commit | `commit` | Creates local commits for one or more recorded apply-runs (no push/PR) |
| Impact tracking | (on `--apply`) | Appends per-binding rows to centralized JSON + CSV logs |

**Scope:** `find` / `report` / `rename` / `remove` are HTML templates only. `remove-unused` and `fix-io-names` also best-effort update `@Input`/`@Output` members in the defining component `.ts`.

**Matching rule:** only real attribute / binding **names** are matched — not the same text inside quoted values (e.g. `[abcd]="obj.isCustomIcon"` or `*ngIf="... == 'table'"` are ignored when searching for `isCustomIcon` / `table`).

A legacy Python reference (`angular_io_tool.py`) remains in the repo for parity on find/report/rename/remove only. New features (interactive config, impact logs, local commit, env/user config) are **TypeScript / ngpilot only**.

<a id="installation-guide"></a>
## Installation guide

- Make a classic github PAT (Personal Access Token). It should have read access to github packages. Your github username must be allowed for accessing that package(Ask the maintainer to give you access to ngpilot package).
- Authenticate with GitHub (one-time setup)<br>
`npm login --scope=@Orektic --registry=https://npm.pkg.github.com`
- Install globally <br>
`npm install -g @Orektic/ngpilot`
- Execute<br>
`ngpilot --help`
---

<a id="requirements"></a>
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

<a id="configuration-resolution"></a>
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
| `NGPILOT_NAME_DICT` | Extra word list for `fix-io-names` segmentation | Absolute file path |

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

<a id="cli-help"></a>
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

<a id="shared-options"></a>
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

<a id="commands"></a>
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

### `remove-unused`

Audits decorator `@Input` / `@Output` APIs on every `@Component` under roots (signals out of scope).

1. Resolve selector (literal / same-file const); **prompt inline** if unknown (Enter = skip component)  
2. Parse inputs/outputs (aliases + setters); **prompt inline** if a name can’t be parsed (Enter = skip attribute)  
3. One batched HTML find per component for all of its public API names  
4. Write a detailed log (`logs/remove-unused-<timestamp>.log` or `--log`) with per-attribute occurrence counts — **not** dumped to the CLI  
5. For each attribute with **0** HTML hits → prompt with repo, class name, selector, attribute, defining file  
6. On **Yes**: HTML `remove --apply` + best-effort TS member delete (warn & continue if TS delete fails)  
7. End (or **Q** quit) writes the detail log and prints hashes, affected repos, log/impact paths, and counts

Unused-attribute controls (shown once at start; prompt `[Y/n/nc/nr/q]`):

| Key | Meaning |
|---|---|
| `Y` | Remove this unused attribute |
| `N` / Enter | Skip this attribute only (default) |
| `NC` | Skip remaining unused attributes on **this component** |
| `NR` | Skip remaining unused attributes in **this repository** |
| `Q` | Quit early (still writes log + prints the same end summary) |

```powershell
ngpilot remove-unused --roots D:\angular-repos
ngpilot remove-unused --log D:\ngpilot-data\unused-run.log
```

### `fix-io-names`

Audits decorator `@Input` / `@Output` **public names** against naming standards (signals out of scope):

1. **Outputs must not start with `on`** (case-insensitive)  
2. **Names must be proper camelCase** (e.g. `validchange` → suggest `validChange`)

Word segmentation uses a built-in dictionary (`ts/data/name-words.txt`, copied to `dist/data/`). Optional extras:

```powershell
ngpilot fix-io-names --name-dict D:\path\my-words.txt
$env:NGPILOT_NAME_DICT = "D:\path\my-words.txt"
```

Dictionary format: plain text, one word per line, `#` comments allowed. CLI `--name-dict` and `NGPILOT_NAME_DICT` are **merged** with the built-in list.

Workflow:

1. Resolve selector / parse members (same inline prompts as `remove-unused`)  
2. For each naming violation → prompt with repo, class, selector, attribute, rules, suggested name, defining file  
3. On **Yes**: confirm/edit suggested name (re-prompt on collision or invalid identifier) → HTML rename across roots + best-effort TS rename (alias/property; warn & continue if TS fails)  
4. End (or **Q**) writes `logs/fix-io-names-<timestamp>.log` and prints hashes, affected repos, log/impact paths, and counts

Controls (shown once; prompt `[Y/n/nc/nr/q]`):

| Key | Meaning |
|---|---|
| `Y` | Rename this attribute (then confirm/edit suggested name) |
| `N` / Enter | Skip this attribute only (default) |
| `NC` | Skip remaining violations on **this component** |
| `NR` | Skip remaining violations in **this repository** |
| `Q` | Quit early (still writes log + prints the same end summary) |

```powershell
ngpilot fix-io-names --roots D:\angular-repos
ngpilot fix-io-names --name-dict D:\path\my-words.txt --log D:\ngpilot-data\fix-io.log
```

### `commit` (local only)

Creates local feature-branch commits from one or more recorded `--apply` change-run hashes. **No push, no PR, no token.**

```powershell
ngpilot commit
ngpilot commit <hash> --branch-name feature/rename-icon --target-branch qa --title "rename isCustomIcon" --body "..."
ngpilot commit hash1 hash2 hash3 --branch-name feature/cleanup --target-branch qa --title "remove unused APIs"
```

Per repo (per hash): stash → resolve target → create/reset feature branch from target (existing local branch is hard-reset to target) → apply tool hunks only → local commit → restore previous branch and discard tool-touched files on the original branch → print repo / branch / sha.

---

<a id="interactive-mode"></a>
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
| `remove-unused` | roots → logs/runs/impact (if unset) → confirm → inline selector/attr prompts → per-unused delete? (default No) |
| `fix-io-names` | roots → logs/runs/impact (if unset) → optional name-dict → confirm → inline prompts → per-violation rename? (default No) |
| `remove` | selector → inputs/outputs → roots → apply? → logs/runs/impact (if unset) → confirm |
| `commit` | hash → branch-name → target-branch → title → body → confirm |

Enter accepts defaults. After a dry-run in interactive rename/remove, you can choose to apply immediately.

---

<a id="impact-area-logging"></a>
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

<a id="change-runs"></a>
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

<a id="run-logging"></a>
## Run logging

Every command writes a transcript by default (ANSI stripped) under the logs directory, unless `--no-log` or a custom `--log <file>` is used.

Logged metadata includes command, selector, roots, apply flag, change-run hash, and impacted files.

---

<a id="typical-workflow"></a>
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

<a id="behaviour-notes"></a>
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

<a id="limitations"></a>
## Limitations

- `find` / `report` / `rename` / `remove` do not modify `.ts` component class files (except `remove-unused` / `fix-io-names`, which best-effort update `@Input`/`@Output` members)
- Does not rename the component selector itself
- Does not push remotes or open pull requests
- Impact `component-affected` does not resolve selectors imported from other files
- `remove-unused` / `fix-io-names` do not parse Angular signal `input()` / `output()` APIs yet

After renaming template bindings with `rename` alone, update the component TypeScript definitions separately if those API names are changing too (`fix-io-names` updates both).

---

<a id="quick-reference"></a>
## Quick reference

```text
ngpilot find   --selector SEL [--inputs ...] [--outputs ...] [--roots ...]
ngpilot report --selector SEL [--format markdown|json] [-o FILE] [--roots ...]
ngpilot rename --selector SEL --rename old=new[,...] [--apply] [--impact-log PATH] [--roots ...]
ngpilot remove --selector SEL (--inputs ... | --outputs ...) [--apply] [--impact-log PATH] [--roots ...]
ngpilot remove-unused [--roots ...] [--impact-log PATH] [--log FILE]
ngpilot fix-io-names  [--roots ...] [--impact-log PATH] [--name-dict FILE] [--log FILE]
ngpilot commit [HASH ...] --branch-name NAME --target-branch BASE --title TEXT [--body TEXT]

Shared: [--logs-dir DIR] [--runs-dir DIR] [--log FILE] [--no-log] [-i]
```

---

## Tests

```powershell
cd d:\Tools\ngpilot\ts
npm test
```

Runs local-commit, impact/config, remove-unused, and fix-io-names tests.
