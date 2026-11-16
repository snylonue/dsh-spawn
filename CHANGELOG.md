# Changelog

## 4.0.1

- Declare DSH `0.2.2-rc.2 || 0.2.2-rc.3` support in host engines and DSH SDK peers.
- Retain the rc.2 build dependency baseline and existing runtime behavior; release as a patch.

## 4.0.0

### Breaking changes

- Require DSH 0.2.2-rc.2 exactly; DSH 0.2.1 and earlier hosts are no longer supported. Upgrade the host before installing.
- Bump the major version because the previously supported host is no longer compatible.

### Changes

- Align SDK dependencies, peers, and host-version checks with the rc2 runtime.
- Preserve the existing spawn, stat, list_dir, working-directory, and sandbox behavior.
