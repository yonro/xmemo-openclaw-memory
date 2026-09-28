# ADR-L01: SQLite platform and driver probe

- Status: **Local probe complete; cross-platform CI evidence partial; support decision remains open**
- Date: 2026-09-28
- Scope: P1a platform probe from Hybrid plan v2 §§5.1, 5.2, 19.1, and 19.6. This is evidence for a future local kernel, not an implementation or support claim for plugin 1.0.18.
- Baseline: `7d25b41be0ce0d0ce84a6f1716754353188d0dc2`

## Decision

Keep Node's built-in `node:sqlite` as the preferred driver candidate for the next design slice. It passed the exercised database, Worker, WAL-lock, backup, full-disk, corruption, and process-crash checks on macOS arm64 at the declared OpenClaw Node floor, the current LTS, and the local runtime. It requires no native package install or compile step. This probe does **not** freeze the production driver, establish full Local support, or establish Linux or Windows support. ADR-L02/H01 and the P1b review gate remain outstanding.

The project consumes `openclaw@2026.6.9`, whose package declares Node `>=22.19.0`; this repository package itself does not declare an `engines.node` range. The original local runtime matrix used Node 22.19.0 (declared floor), Node 24.21.0 (current LTS on the local probe date), and the machine's Node 26.9.0. The authorized CI matrix requested `24.x`; hosted runners resolved it to Node 24.21.0 on Linux and Windows and Node 24.20.0 on macOS during runs 36373750828 and 36374695938. Node 22.19.0 loads `node:sqlite` without a flag but prints an `ExperimentalWarning`. Node 24.21.0 and 26.9.0 do not print that warning. SQLite `backup()` is available at the declared floor; see the [Node SQLite API](https://nodejs.org/api/sqlite.html).

Use a file-backed database in WAL mode only on a local filesystem. Do not place an active database on NAS, network shares, Dropbox, or a cross-device sync folder. Use the online backup API rather than copying the active main database file. Set `synchronous=FULL` for confirmed memory writes. A process-kill result is not evidence of power-loss durability. The WAL and filesystem boundary follows the [SQLite WAL documentation](https://www.sqlite.org/wal.html).

## Platform and runtime evidence

| OS / architecture | Node versions | Status | Evidence boundary |
|---|---|---|---|
| macOS 26.5.2, arm64 (`Mac16,10`) | 22.19.0, 24.21.0, 26.9.0 | **Verified for probes below** | All runs used the same Apple Silicon host and local HFS+/APFS filesystems. This does not establish support on every macOS release or filesystem. |
| Linux x64 | 22.19.0, 24.21.0 (`24.x`), 26.10.0 | **Matrix passed** | SQLite probe, tmpfs disk-full probe, tests, typecheck, and lint passed for all three Node versions in [run 36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) and [run 36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938). Initial setup failure remains recorded below. |
| Linux arm64 | 22.19.0, 24.21.0 (`24.x`), 26.10.0 | **Matrix passed** | SQLite probe, tmpfs disk-full probe, tests, typecheck, and lint passed for all three Node versions in [run 36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) and [run 36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938). Initial setup failure remains recorded below. |
| Windows x64 | 22.19.0, 24.21.0 (`24.x`), 26.10.0 | **SQLite probes passed; full suite failed** | SQLite probes passed for all three Node versions in [run 36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) and [run 36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938); the same documentation-parity test failed on CRLF/LF comparison. Typecheck and lint were skipped after the test failure. Initial setup failure remains recorded below. |
| macOS arm64 | 22.19.0, 24.20.0 (`24.x`), 26.10.0 | **Two pass; Node 22 probe failed** | [Run 36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938): Node 24.20.0 and 26.10.0 passed the SQLite probe, disk-image full-disk probe, tests, typecheck, and lint. Node 22.19.0 failed the worker responsiveness assertion with a 298.6 ms main-thread timer gap against the 250 ms limit; later steps were skipped. Run 36373750828's lock-timing failures remain recorded below. |
| Other OS / architectures | — | **Unverified** | No support claim. |

The macOS runtime results were:

| Node | SQLite | `node:sqlite` flag / warning | FTS5 / JSON / file WAL | Worker and all core checks |
|---|---:|---|---|---|
| 22.19.0 | 3.50.4 | No flag; experimental warning | `COMPILER=clang-16.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |
| 24.21.0 | 3.53.4 | No flag; no warning | `COMPILER=clang-16.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |
| 26.9.0 | 3.53.4 | No flag; no warning | `COMPILER=clang-17.0.0`, `ENABLE_FTS5`, `THREADSAFE=1`, `DEFAULT_WAL_AUTOCHECKPOINT=1000`, `DEFAULT_WAL_SYNCHRONOUS=2`; JSON functions passed | Passed |

`PRAGMA compile_options` is printed in full by the probe so future runs can compare the complete build configuration. WAL is verified by setting and reading `PRAGMA journal_mode=WAL` on a file-backed database; WAL is not inferred from a compile option.

The first authorized CI attempt, run [36372400347](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36372400347), failed in `pnpm/action-setup` on all 12 OS × Node jobs before dependency installation, SQLite probes, disk-full probes, or tests. The action received `version: 10.33.0` while `package.json` already pinned `pnpm@10.33.0+sha512...` in `packageManager`, so setup rejected the duplicate version declarations. Every matrix pair was **failed before platform evidence**, not a probe failure: Ubuntu x64, Ubuntu arm64, Windows x64, and macOS arm64 each failed for Node 22.19.0, 24.x, and 26.10.0. No SQLite version or compile options were collected by that run. The workflow now reads the repository's pinned `packageManager` field; its results are recorded below without replacing this failed attempt.

### CI attempt 2

[Run 36373750828](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828) used the corrected pnpm setup and completed all 12 jobs. Node `24.x` resolved to different patch releases on the hosted runner pools during this run; the table records the runtime version actually reported by each probe. The compile-option summary below includes `COMPILER`, `ENABLE_FTS5`, `THREADSAFE`, `DEFAULT_WAL_AUTOCHECKPOINT`, and `DEFAULT_WAL_SYNCHRONOUS`, plus the platform mutex option.

| OS / architecture | Requested → actual Node | SQLite; compile-option summary | Probe | Disk-full | Tests / typecheck / lint | Job |
|---|---|---|---|---|---|---|
| Linux x64 | 22.19.0 → 22.19.0 | 3.50.4; gcc-10.3.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250535) |
| Linux x64 | 24.x → 24.21.0 | 3.53.4; gcc-12.2.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250438) |
| Linux x64 | 26.10.0 → 26.10.0 | 3.53.4; clang-20.1.8; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250611) |
| Linux arm64 | 22.19.0 → 22.19.0 | 3.50.4; gcc-10.3.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250528) |
| Linux arm64 | 24.x → 24.21.0 | 3.53.4; gcc-12.2.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250518) |
| Linux arm64 | 26.10.0 → 26.10.0 | 3.53.4; clang-20.1.8; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250543) |
| Windows x64 | 22.19.0 → 22.19.0 | 3.50.4; msvc-1944; atomic=0; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250570) |
| Windows x64 | 24.x → 24.21.0 | 3.53.4; clang-19.1.5; atomic=1; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250581) |
| Windows x64 | 26.10.0 → 26.10.0 | 3.53.4; clang-19.1.5; atomic=1; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250592) |
| macOS arm64 | 22.19.0 → 22.19.0 | 3.50.4; clang-16.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Fail: expected `busy`, got `acquired` at process-lock check | Skipped | Skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250626) |
| macOS arm64 | 24.x → 24.20.0 | 3.53.4; clang-16.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Fail: expected `busy`, got `acquired` at process-lock check | Skipped | Skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250635) |
| macOS arm64 | 26.10.0 → 26.10.0 | 3.53.4; clang-17.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Fail: expected `busy`, got `acquired` at process-lock check | Skipped | Skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36373750828/job/108775250520) |

The macOS probe failure was caused by the 700 ms lock-holder window expiring before the child contender acquired the lock; the probe now holds the lock for 2.5 seconds to preserve the intended overlap on hosted runners. On Windows, `child.kill('SIGKILL')` is Node.js signal emulation: Windows has no POSIX signal termination, and libuv uses `TerminateProcess` for this unconditional process termination. This is not POSIX `SIGKILL` delivery and does not establish power-loss durability. See the [Node.js process signal documentation](https://nodejs.org/api/process.html#signal-events), [libuv process-kill implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c), and [Microsoft `TerminateProcess` documentation](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess).

### CI attempt 3

[Run 36374695938](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938) reran the 12-job matrix after increasing the macOS lock-holder window to 2.5 seconds. The Linux jobs again passed all probes and checks. macOS Node 24.20.0 and 26.10.0 passed the full workflow, including the HFS+ disk-full probe; Node 22.19.0 stopped in the worker responsiveness check. All Windows SQLite probes passed, while all three Windows test jobs repeated the documentation-parity CRLF/LF failure and skipped typecheck and lint.

| OS / architecture | Requested → actual Node | SQLite; compile-option summary | Probe | Disk-full | Tests / typecheck / lint | Job |
|---|---|---|---|---|---|---|
| Linux x64 | 22.19.0 → 22.19.0 | 3.50.4; gcc-10.3.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026366) |
| Linux x64 | 24.x → 24.21.0 | 3.53.4; gcc-12.2.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026384) |
| Linux x64 | 26.10.0 → 26.10.0 | 3.53.4; clang-20.1.8; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026223) |
| Linux arm64 | 22.19.0 → 22.19.0 | 3.50.4; gcc-10.3.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026285) |
| Linux arm64 | 24.x → 24.21.0 | 3.53.4; gcc-12.2.1; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026104) |
| Linux arm64 | 26.10.0 → 26.10.0 | 3.53.4; clang-20.1.8; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (tmpfs) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026316) |
| Windows x64 | 22.19.0 → 22.19.0 | 3.50.4; msvc-1944; atomic=0; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026440) |
| Windows x64 | 24.x → 24.21.0 | 3.53.4; clang-19.1.5; atomic=1; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026319) |
| Windows x64 | 26.10.0 → 26.10.0 | 3.53.4; clang-19.1.5; atomic=1; FTS5; W32 mutex; threadsafe=1; WAL=1000/2 | Pass | Not applicable | Fail: documentation-parity CRLF/LF comparison (277/278 tests); typecheck and lint skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026281) |
| macOS arm64 | 22.19.0 → 22.19.0 | 3.50.4; clang-16.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Fail: worker timer gap 298.6 ms > 250 ms | Skipped | Skipped | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026331) |
| macOS arm64 | 24.x → 24.20.0 | 3.53.4; clang-16.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (HFS+) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026263) |
| macOS arm64 | 26.10.0 → 26.10.0 | 3.53.4; clang-17.0.0; atomic=1; FTS5; pthreads; threadsafe=1; WAL=1000/2 | Pass | Pass (HFS+) | Pass / pass / pass | [Job](https://github.com/yonro/xmemo-openclaw-memory/actions/runs/36374695938/job/108778026260) |

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

The original local probe commands passed on all three macOS runtimes, and the disk-full command passed on macOS. CI attempt 1 failed at package-manager setup; attempt 2 and attempt 3 results are recorded above, including each matrix pair's failures. The local run after increasing the macOS lock-holder window passed on Node v26.9.0 / SQLite 3.53.4; hosted macOS Node 22.19.0 remains unverified because the responsiveness threshold was exceeded.

## Driver, packaging, and failure model

`node:sqlite` is included with Node, so this candidate adds no package download or native compilation step. The current package preview remains 45 files, and the probe directory is excluded by the existing package allowlist. No third-party binding was evaluated because the built-in driver met the exercised local requirements; a replacement becomes a separate decision if required platform probes fail or a later gate exposes a driver limitation. A future alternative comparison must record licensing, package size, prebuilt OS/CPU coverage, and install behavior before selection.

The observed errors are explicit but should be mapped into product-level outcomes before integration: lock contention surfaced as SQLite error code 5; volume exhaustion surfaced as code 13; and a corrupt database surfaced as `ERR_SQLITE_ERROR`. Do not turn these cases into empty-database fallback or reported success. This probe did not implement that production mapping.

## Open gates and next review

1. Linux x64/arm64 passed all matrix probes and checks in run 36374695938. macOS Node 24.20.0 and 26.10.0 passed; Node 22.19.0 failed when the worker probe measured a 298.6 ms main-thread timer gap against its 250 ms limit. Windows SQLite probes passed, but the full suite remains incomplete because the documentation-parity test compares CRLF and LF bytes; typecheck and lint were skipped. The human authorized branch-limited CI in review chat `7b191229`; only `ci/sqlite-platform-probe` may be pushed for this evidence, with no `master` or tag push, PR, or release.
2. The `SIGKILL` test does not test a hard reset or power loss. Those require a separate controlled reliability experiment.
3. CJK tokenizer quality remains open; the measured `unicode61` misses must inform FTS design and evaluation, but this ADR does not choose a tokenizer or alter product behavior.
4. No Local database integration, migration, package change, or product runtime change is part of this slice. The CI workflow is evidence-only and restricted to the authorized branch.
5. P1b must first freeze ADR-L02/H01 as specified by the plan. This P1a result is submitted for review; no later slice is started here.
