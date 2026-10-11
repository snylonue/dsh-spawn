# dsh-spawn

Provides a `spawn` tool that executes a command directly without shell, and independently configurable `stat` and `list_dir` tool plugins.

## Installation

Install the npm package into a DSH profile after the release is published:

```sh
dsh plugin --profile example-profile add @snylonue/dsh-spawn
```

The plugin manager registers the bundle automatically. Replace `example-profile` with the intended profile.

## Tools and preset

`spawn` requires the `jobs`, `sandbox`, and `sandboxPolicy` services. Every invocation starts a job; foreground calls wait for completion and move the job to the background on timeout. Infrastructure failures throw in foreground calls and settle background jobs as `failed`; nonzero command exits remain ordinary results.

The `@snylonue/dsh-spawn` entry registers only `spawn`. Load `@snylonue/dsh-spawn/stat` and `@snylonue/dsh-spawn/list-dir` separately for filesystem queries. The `PTC-spawn` preset enables all three by default. To disable either query tool in that preset, set `disabled: true` on its entry under `preset-ptc-spawn.config.plugins`:

The top-level `tool-stat` and `tool-list-dir` entries are separate declarations and are already disabled. Changing them does not disable the copies inside the preset. Edit the corresponding preset child entries shown below:

```yaml
- id: tool-stat
  name: '@snylonue/dsh-spawn/stat'
  disabled: true
- id: tool-list-dir
  name: '@snylonue/dsh-spawn/list-dir'
  disabled: true
```

Each entry can be enabled or disabled independently. Configurations that previously loaded `@snylonue/dsh-spawn` directly for all three tools must add the two new plugin entries to keep the query tools available.

A preset (`PTC-spawn` (id `ptc-spawn`)) is provided, which is based on PTC mode and replaces `shell` with above tools.

This might improve how a model executes programs (typesrcipt is better than bash to compose multiple programs and process outputs) and probably prevent models from struggling with pwsh on windows.

`spawn` resolves `command` in the execution world and starts it through `ctx.subprocess` as an argv vector (`[command, ...args]`), under the composed sandbox policy. Arguments are delivered verbatim on every platform — there is no shell and therefore no quoting. On Windows a `.cmd`/`.bat` target is rejected: batch files need a command shell, which this tool deliberately does not have; invoke `cmd` with `args: ["/c", ...]` or a real executable instead.

## npm publishing

The workflow in [.github/workflows/publish.yml](./.github/workflows/publish.yml) follows the dsh-direnv release process: pushing a `v*` tag installs locked dependencies with pnpm on Node.js 24, builds the package, runs the checks, previews the npm archive, and publishes publicly with provenance. The tag must equal `v` plus the version in `package.json`; other pushes do not publish.

Use the GitHub repository `snylonue/dsh-spawn` and configure an npm trusted publisher for `@snylonue/dsh-spawn` with workflow filename `publish.yml`. The workflow uses GitHub OIDC (`id-token: write`) without an npm token. Enable direct `npm publish` for the trusted publisher. The repository must be public for provenance. Configure publishing access before pushing a release tag; if the package does not yet have an npm settings page, its initial authenticated publication must be handled separately after review. See the [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) for the account-side setup.

For local review, run:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
npm pack --dry-run
```

The prepack hook builds the compiled ESM modules and TypeScript declarations before packing. `npm pack --dry-run` does not publish. Keep the release tag and publication pending until the package contents have been reviewed.
