# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and optional `stat` and `list_dir` tool plugins.

## Installation

Install the npm package into a DSH profile after the release is published:

```sh
dsh plugin --profile web add @snylonue/dsh-spawn
```

## Supported host and working directory

Only DSH 0.2.1-rc.2 is supported. `spawn`, `stat`, and `list_dir` require the host working-directory service, including directory changes and missing-directory recovery. Relative `cwd` overrides resolve against that current directory. The sandbox workspace root does not change. There is no older-host service probe or workspace/header cwd fallback.

## Directory ignore rules

`list_dir` uses ripgrep-style **project-level** filters by default. `ignore` and `hidden` are independent options:

- `ignore` defaults to `true`: apply project ignore-file rules. Setting it to `false` does not enable hidden entries and does not read ignore files.
- `hidden` defaults to `false`: skip dotfiles and dot-directories, including `.git`, `.hg`, `.svn`, `.env` and `.cache`. Setting it to `true` does not bypass ignore-file rules. When ignore rules are enabled, an explicit whitelist can still include a hidden entry even with `hidden: false`.

| Options | Behavior |
| --- | --- |
| Defaults (`ignore: true, hidden: false`) | Apply ignore rules and skip non-whitelisted hidden entries |
| `ignore: true, hidden: true` | Include hidden entries unless excluded by ignore rules |
| `ignore: false, hidden: false` | Disable ignore rules but continue skipping hidden entries |
| `ignore: false, hidden: true` | Include hidden and ignored entries |

Empty visible directories are still listed; this is not a wrapper around `rg --files`. Symbolic-link behavior is unchanged in this patch: entries are skipped while `ignore` is true; with `ignore: false`, the underlying host listing/traversal behavior is preserved. No separate link-following option is introduced here.

Glob parsing reuses the npm `ignore` package. Conflicting rules use `.rgignore` > `.ignore` > `.gitignore` > `.git/info/exclude` precedence, regardless of directory depth; within one source type, deeper rules win. Git rules require a repository (`.git` or `.jj`), and stop at nested repository boundaries. Parent `.ignore` and `.rgignore` files continue across repository boundaries. Worktree/submodule Git metadata and shared `commondir` exclude files are supported. Ignored directories are pruned before recursion and do not consume the 2000-entry limit. Rules inside pruned directories cannot reopen them. As with rg, explicitly requested starting directories are traversed even if hidden or ignored.

All filesystem access uses the host `ctx.fs` service; symlinked rule files are not followed. This is not full ripgrep compatibility: rules are case-sensitive, hidden means dot-prefixed (Windows hidden attributes are unavailable), global Git configuration/excludes and per-user ripgrep configuration are not loaded, and the tracked-file index is not consulted. This directory-listing tool does not inspect file contents or filter binary files. Tests compare supported project filtering against a real `rg --files` binary when available.

Pass both `ignore: false` and `hidden: true` to include hidden and ignored entries without reading ignore files. This replaces the earlier combined behavior of `ignore: false`:

```json
{ "path": ".", "depth": 3, "ignore": false, "hidden": true }
```

## Tools and preset

`spawn` requires the `jobs`, `sandbox`, `sandboxPolicy`, and `workingDirectory` services. Every invocation starts a job; foreground calls wait for completion and move the job to the background on timeout. Infrastructure failures throw in foreground calls and settle background jobs as `failed`; nonzero command exits remain ordinary results.

The `@snylonue/dsh-spawn` entry registers only `spawn`. Load `@snylonue/dsh-spawn/stat` and `@snylonue/dsh-spawn/list-dir` separately for filesystem queries. The `PTC-spawn` preset enables all three by default. To disable either query tool in that preset, set `disabled: true` on its entry under `preset-ptc-spawn.config.plugins`:

The top-level `tool-stat` and `tool-list-dir` entries are separate declarations and disabled by default. Changing them does not disable the copies inside the preset. Edit the corresponding preset child entries shown below:

```yaml
- id: tool-stat
  name: '@snylonue/dsh-spawn/stat'
  disabled: true
- id: tool-list-dir
  name: '@snylonue/dsh-spawn/list-dir'
  disabled: true
```

A preset (`PTC-spawn` (id `ptc-spawn`)) is provided, which is based on PTC mode and replaces `shell` with above tools.

Hopefully, this tool improves how a model executes programs (typesrcipt is better than bash to compose multiple programs and process outputs and prevents model struggling with pwsh).