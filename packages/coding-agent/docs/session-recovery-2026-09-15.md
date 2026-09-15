# September 15 session recovery

## Scope and evidence

Reviewed the latest parent session `01a0a682` and its review sessions `01a0a6b1`
and `01a0a6b9`, then followed their references to the preceding root sessions
`01a0a579` and `01a0a4cc`. Baseline repository HEAD is `779fc690e`; the installed
release at investigation start was v0.99.24. The source tree already contained
unfinished IPC and mutation-formatting patches.

## Confirmed defects

| Defect | Authoritative correction | Evidence |
| --- | --- | --- |
| Collaboration readiness crashed when Bun supplied an IPC channel without `unref` | Check whether the channel method is callable; retain process unref and exact-turn exit handling | Missing/non-callable method cases, Node control, stale/duplicate readiness, timeout/exit tests, real Node/Bun IPC and compiled Bun probe |
| Edit/write synchronously invoked Biome and changed requested bytes | Remove automatic formatting from both mutation owners; use the applied edit content for the written bytes and diff | BOM/newline preservation, unchanged neighboring text, byte counts, exact content-reference copies, and no formatter invocation |
| Python source with mixed quotes became a fabricated filename during credential screening | Preserve literal boundaries while inspecting strings inside executable f-string expressions | The exact failed session source reproduced `ENAMETOOLONG` before Python launched; focused regressions include protected-path controls |
| Credential redaction discarded structured error classification from another runtime constructor | Reuse `readAgentToolExecutionError` at the credential boundary | Both operation outcomes and tool failures retain metadata while diagnostics are redacted; invalid classifications remain ordinary errors |

The previous IPC test fixture itself failed type checking because its channel
required `unref`. Its model now allows the runtime shapes the regression tests.
The mutation test's dynamic type import was also removed.

## Earlier work and rejected candidates

- `779fc690e` already contains completed Python nonzero-exit classification,
  excluded-skill discard classification, and focused TUI `node:test` routing.
- The earlier release contains goal/task catalogs, missing-file recovery ownership,
  GitHub origin pinning, and login-paste handling. Focused goal/recovery and paste
  regressions were rerun during this recovery.
- Python stdin transport and the session pathname's length were rejected as causes
  of the reproduced failure: credential screening failed before process execution.
- Deleting spaces from a supplied path or substituting another live step for a
  missing compacted ordinal would change the requested identity. Those proposed
  rewrites remain rejected.
- The orphan warning is report-only for a foreign parent session. It does not
  explain the readiness callback exception, and foreign recovery records were
  not rewritten to hide it.
- The unused formatter helper remains as requested by the prior review; there is
  no active alternate formatting path in edit/write.

## Verification limits

Independent Astra high review caught a regression in the first quote-regex fix:
an outer f-string hid a protected filename inside its expression. That candidate
was rejected before activation and required a dedicated regression and correction.

The historical Windows worktree-cleanup `EPERM` reports remain unproven on this
Linux host. Earlier lifecycle fixes and later nonrecurrence do not establish a
permanent repair. Native Windows execution and the full GitHub matrix are outside
the local evidence; no official release was created by this recovery.

Credential screening remains a static inspection mechanism, not a Python sandbox.
Local runtime smoke checks exercise startup, shell RPC, IPC admission and clean
exit without making provider requests or replaying live session transcripts.

## Final local validation

- `npm run check` passes, including type checking, architecture/import gates,
  browser smoke checks, and installer/binary regressions. npm emits the existing
  host-configuration warning about `globalignorefile`; repository checks have no
  reported errors.
- Production clone coverage reconciles 1,027 eligible files out of 1,036 owned
  files; nine files are below the five-line detection floor. The 50-token pass
  analyzes 996 files and reports zero clones. Explicit limits are 20,000 lines
  and 2 MiB, above the largest source (4,755 lines / 189,328 bytes).
- Ten mutation/collaboration suites pass 88 tests. Goal/recovery and mutation
  follow-up checks pass 56 tests. These groups overlap on the mutation regression.
- Credential/Python checks pass, including the final 26-case literal suite.
  Independent Astra high review reruns 57 credential tests and approves the
  corrected implementation. It also independently approves IPC/mutation changes.
- TUI input and paste checks pass 48 tests across three files.
- Real Node IPC, Bun IPC, and a compiled Bun IPC probe admit the child and release
  the parent. The rebuilt CLI passes isolated cold/warm shell RPC and clean exit.

The local repair is packaged separately at
`~/.local/share/pi-adaptative/releases/local-repair-20260915-779fc690e`.
Its `LOCAL-REPAIR.json` records the base commit, source/binary hashes and previous
installation. Package version remains 0.99.24; this is an unreleased local repair.
The original `releases/v0.99.24` package remains available for rollback. Repository
changes are uncommitted.
