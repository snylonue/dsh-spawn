# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and `stat` and `list_dir` helpers.

A preset (`PTC-spawn` (id `ptc-spawn`)) is provided, which is based on PTC mode and replaces `shell` with above tools.

This might improve how a model executes programs (typesrcipt is better than bash to compose multiple programs and process outputs) and probably prevent models from struggling with pwsh on windows.
