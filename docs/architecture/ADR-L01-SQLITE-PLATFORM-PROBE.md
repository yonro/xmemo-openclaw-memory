# ADR-L01: SQLite platform and driver probe

- Status: **Probe complete on macOS arm64; cross-platform decision remains open**
- Date: 2026-09-28
- Scope: P1a platform probe from Hybrid plan v2 §§5.1, 5.2, 19.1, and 19.6. This is evidence for a future local kernel, not an implementation or support claim for plugin 1.0.18.
- Baseline: `7d25b41be0ce0d0ce84a6f1716754353188d0dc2`

## Decision

Keep Node's built-in `node:sqlite` as the preferred driver candidate for the next design slice. It passed the exercised database, Worker, WAL-lock, backup, full-disk, corruption, and process-crash checks on macOS arm64 at the declared OpenClaw Node floor, the current LTS, and the local runtime. It requires no native package install or compile step. This probe does **not** freeze the production driver, establish full Local support, or establish Linux or Windows support. ADR-L02/H01 and the P1b review gate remain outstanding.

The project consumes `openclaw@2026.6.9`, whose package declares Node `>=22.19.0`; this repository package itself does not declare an `engines.node` range. The runtime matrix used here is Node 22.19.0 (declared floor), Node 24.21.0 (current LTS on the probe date), and the machine's Node 26.9.0. Node 22.19.0 loads `node:sqlite` without a flag but prints an `ExperimentalWarning`. Node 24.21.0 and 26.9.0 do not print that warning. SQLite `backup()` is available at the declared floor; see the [Node SQLite API](https://nodejs.org/api/sqlite.html).

Use a file-backed database in WAL mode only on a local filesystem. Do not place an active database on NAS, network shares, Dropbox, or a cross-device sync folder. Use the online backup API rather than copying the active main database file. Set `synchronous=FULL` for confirmed memory writes. A process-kill result is not evidence of power-loss durability. The WAL and filesystem boundary follows the [SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Platform and runtime evidence

| OS / architecture | Node versions | Status | Evidence boundary |
|---|---|---|---|
| macOS 26.5.2, arm64 (`Mac16,10`) | 22.19.0, 24.21.0, 26.9.0 | **Verified for probes below** | All runs used the same Apple Silicon host and local HFS+/APFS filesystems. This does not establish support on every macOS release or filesystem. |
| Linux x64 | — | **Unverified** | No Docker or Linux host was available locally; no remote CI was triggered. |
| Linux arm64 | — | **Unverified** | No native host or local container runtime was available; no remote CI was triggered. |
| Windows x64 | — | **Unverified** | No Windows host was available; no remote CI was triggered. |
| Other OS / architectures | — | **Unverified** | No support claim. |

The macOS runtime results were:

| Node | SQLite | `node:sqlite` flag / warning | FTS5 / JSON / file WAL | Worker and all core checks |
|---|---:|---|---|---|
| 22.19.0 | 3.50.4 | No flag; experimental warning | `COMPILER=clang-16.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |
| 24.21.0 | 3.53.4 | No flag; no warning | `COMPILER=clang-16.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |
| 26.9.0 | 3.53.4 | No flag; no warning | `COMPILER=clang-17.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |

`PRAGMA compile_options` is printed in full by the probe so future runs can compare the complete build configuration. WAL is verified by setting and reading `PRAGMA journal_mode=WAL` on a file-backed database; WAL is not inferred from a compile option.

## Probe results

The repeatable harness is in [`probes/sqlite/`](../../probes/sqlite/README.md). From the repository root, run `node probes/sqlite/probe.mjs` with each target Node executable. On macOS, run `sh probes/sqlite/disk-full-macos.sh` as well. The scripts create isolated temporary databases and remove them; they do not import product code, read credentials, or alter the plugin's local cache.

- **Worker:** a Worker opened the same file, inserted and read a row, and completed a 2.5-million-row recursive query in about 189–243 ms. While it ran, the main-thread 5 ms timer fired 32–37 times; the largest observed interval was 6.3–10.8 ms.
- **WAL lock and lease:** while one process held `BEGIN IMMEDIATE`, a second connection read in 0.1–0.2 ms. A contender with `busy_timeout=250` returned SQLite busy (`errcode=5`, “database is locked”) after 310–335 ms on this host. Two processes raced for the prototype lease; exactly one acquired it. The measured timeout includes SQLite scheduling and should be treated as host evidence, not a precise timing guarantee.
- **Process-crash durability:** five randomized `SIGKILL` points per Node version (15 runs total) followed acknowledged commits under `synchronous=FULL`. Every reopened database contained at least all commit acknowledgements observed before the kill. This covers process termination only; it does not prove survival of power loss, kernel failure, or storage-controller cache loss.
- **Online backup:** `node:sqlite` `backup()` ran with concurrent inserts, and each restored database returned `integrity_check=ok` with a consistent row count. In a separate WAL example, copying only the active main file preserved the table but omitted an uncheckpointed committed row (0 rows in the copy versus 1 in the source).
- **Disk full:** the macOS script created a disposable 96 MiB HFS+ image, left a 2 MiB reserve, and filled it through SQLite. After one 1 MiB row committed, the next write failed with SQLite `errcode=13` and “database or disk is full”. The image detached and was deleted by the script.
- **Corruption:** a file containing non-SQLite bytes failed integrity checking with `ERR_SQLITE_ERROR: file is not a database`.
- **FTS5:** `ENABLE_FTS5` was present; `unicode61` and `trigram` tables both created. The selected two-character Chinese, Japanese, and Korean queries returned 0 matches with `unicode61`; the corresponding three-character trigram substring queries returned 1 each. This is an observed tokenizer behavior, not a quality acceptance result. No language-specific tokenization fix is included.
- **No-compile install and package:** requiring `node:sqlite` from a fresh empty directory passed on all three versions. `npm pack --dry-run --ignore-scripts --json` reported 45 files, 126,644 packed bytes, and 409,387 unpacked bytes; it included no `probes/` file. This slice adds no runtime dependency, and the package file allowlist excludes all probe scripts and this ADR.

The main command exited successfully on all three runtimes. The disk-full command exited successfully on macOS. No CI workflow was added, no CI was triggered, and no push was made.

## Driver, packaging, and failure model

`node:sqlite` is included with Node, so this candidate adds no package download or native compilation step. The current package preview remains 45 files, and the probe directory is excluded by the existing package allowlist. No third-party binding was evaluated because the built-in driver met the exercised local requirements; a replacement becomes a separate decision if required platform probes fail or a later gate exposes a driver limitation. A future alternative comparison must record licensing, package size, prebuilt OS/CPU coverage, and install behavior before selection.

The observed errors are explicit but should be mapped into product-level outcomes before integration: lock contention surfaced as SQLite error code 5; volume exhaustion surfaced as code 13; and a corrupt database surfaced as `ERR_SQLITE_ERROR`. Do not turn these cases into empty-database fallback or reported success. This probe did not implement that production mapping.

## Open gates and next review

1. Linux x64/arm64 and Windows x64 remain unverified. Run the same harness on native hosts or locally authorized disposable containers before describing those platforms as supported. Remote CI requires human authorization and was not used here.
2. The `SIGKILL` test does not test a hard reset or power loss. Those require a separate controlled reliability experiment.
3. CJK tokenizer quality remains open; the measured `unicode61` misses must inform FTS design and evaluation, but this ADR does not choose a tokenizer or alter product behavior.
4. No Local database integration, migration, package change, CI workflow, or product runtime change is part of this slice.
5. P1b must first freeze ADR-L02/H01 as specified by the plan. This P1a result is submitted for review; no later slice is started here.
