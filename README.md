# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and `stat` and `list_dir` helpers.

A preset (`PTC-spawn` (id `ptc-spawn`)) is provided, which is based on PTC mode and replaces `shell` with above tools.

This might improve how a model executes programs (typesrcipt is better than bash to compose multiple programs and process outputs) and probably prevent models from struggling with pwsh on windows.

`spawn` resolves `command` in the execution world and starts it through `ctx.subprocess` as an argv vector (`[command, ...args]`), under the composed sandbox policy. Arguments are delivered verbatim on every platform — there is no shell and therefore no quoting. On Windows a `.cmd`/`.bat` target is rejected: batch files need a command shell, which this tool deliberately does not have; invoke `cmd` with `args: ["/c", ...]` or a real executable instead.
