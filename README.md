# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and independently configurable `stat` and `list_dir` tool plugins.

The `dsh-spawn` entry registers only `spawn`. Load `dsh-spawn/stat` and `dsh-spawn/list-dir` separately for filesystem queries. The `PTC-spawn` preset enables all three by default. To disable either query tool in that preset, set `disabled: true` on its entry under `preset-ptc-spawn.config.plugins`:

The top-level `tool-stat` and `tool-list-dir` entries are separate declarations and are already disabled. Changing them does not disable the copies inside the preset. Edit the corresponding preset child entries shown below:

```yaml
- id: tool-stat
  name: dsh-spawn/stat
  disabled: true
- id: tool-list-dir
  name: dsh-spawn/list-dir
  disabled: true
```

Each entry can be enabled or disabled independently. Configurations that previously loaded `dsh-spawn` directly for all three tools must add the two new plugin entries to keep the query tools available.

A preset (`PTC-spawn` (id `ptc-spawn`)) is provided, which is based on PTC mode and replaces `shell` with above tools.

This might improve how a model executes programs (typesrcipt is better than bash to compose multiple programs and process outputs) and probably prevent models from struggling with pwsh on windows.

`spawn` resolves `command` in the execution world and starts it through `ctx.subprocess` as an argv vector (`[command, ...args]`), under the composed sandbox policy. Arguments are delivered verbatim on every platform — there is no shell and therefore no quoting. On Windows a `.cmd`/`.bat` target is rejected: batch files need a command shell, which this tool deliberately does not have; invoke `cmd` with `args: ["/c", ...]` or a real executable instead.
