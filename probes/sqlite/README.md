# Isolated `node:sqlite` platform probe

This directory contains temporary-database probes only. Product code does not import it, and `package.json`'s published-file allowlist excludes it. No database, cache, user content, or credentials from the plugin are read or changed.

Run the main probe from the repository root:

```sh
node probes/sqlite/probe.mjs
```

It prints one JSON record per check and exits nonzero on a failed assertion. It reports the runtime, SQLite version and compile options; exercises FTS5/JSON/WAL; performs Worker read/write and event-loop timing; checks two-process WAL reader/writer and bounded-busy behavior plus a transactional lease prototype; kills a writer with `SIGKILL` after randomized acknowledged commits under `synchronous=FULL`; performs online backup during writes and compares it with a main-file-only copy; checks a corrupt file's error; and requires the built-in module from an empty directory.

On macOS, also run:

```sh
sh probes/sqlite/disk-full-macos.sh
```

The disk-full script creates and mounts a disposable 96 MiB HFS+ disk image under the system temporary directory, fills it to a 2 MiB reserve, checks for SQLite's explicit full-disk error, then detaches and deletes the image. It never uses a repository or user data path. On other operating systems, disk exhaustion must be exercised with that platform's disposable-volume tooling; do not substitute an unbounded write to the host filesystem.

On Linux, the CI matrix runs `sh probes/sqlite/disk-full-linux.sh`. It mounts a disposable 128 MiB tmpfs under the system temporary directory, leaves a 2 MiB reserve, and uses the same SQLite full-disk assertions. If the runner disallows the mount or the available space cannot be determined, the step reports the probe as unavailable and does not write against the host filesystem.

Node 22.19.0, 24.21.0, and the local Node version are the runtime matrix used for ADR-L01. Run the same command with each executable on a native target platform. Do not infer Linux or Windows support from macOS results.
