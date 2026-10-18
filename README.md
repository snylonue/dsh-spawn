# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and optional `stat` and `list_dir` tool plugins.

## Installation

Install the npm package into a DSH profile after the release is published:

```sh
dsh plugin --profile web add @snylonue/dsh-spawn
```

## Supported host and working directory

Only DSH 0.2.1-rc.2 is supported. `spawn`, `stat`, and `list_dir` require the host working-directory service, including directory changes and missing-directory recovery. Relative `cwd` overrides resolve against that current directory. The sandbox workspace root does not change. There is no older-host service probe or workspace/header cwd fallback.

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