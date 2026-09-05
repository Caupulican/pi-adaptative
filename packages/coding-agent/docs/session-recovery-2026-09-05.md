# Session recovery and stable-runtime review

This review resumes the latest repository Pi session from September 5. The source session and user
memory were read without replaying provider calls or mutating live state. Fixes, tests, and operational
documentation are packaged in this repository.

## Confirmed findings addressed

| Finding | Authoritative correction | Focused evidence |
| --- | --- | --- |
| Busy input queued goal controls instead of applying them | Interactive dispatch routes recognized owner controls before ordinary steering; lifecycle stays in the existing goal owner | `interactive-mode-goal-control-routing.test.ts`, goal lifecycle tests |
| Progress receipts implied a paused goal was resumed | Goal tool receipts and documentation explicitly distinguish progress from lifecycle transitions | `goal-tool.test.ts` |
| Worker setup failures lost their reason | Worker preparation returns admission details before asynchronous execution starts | `worker-controller-dag-dispatch.test.ts` |
| Follow-up receipts claimed rejected work was queued | Delegate projects the actual control outcome and identity | `delegate-follow-up-diagnostics.test.ts` |
| Memory drift listings and recovery disagreed | Locked digest inspection and one commit owner serve listing, editing, and reflection | `memory-recovery.test.ts`, `memory-subsystem.test.ts` |
| Repeated recovery duplicated identical backups; oversized files could not shrink | Exact-content backup reuse and monotonic shrink admission at the file store | Memory recovery regressions with conflicting-backup and growth controls |
| Bun WebFetch failed during dispatcher cleanup | Stable Effect HTTP service with explicitly scoped native HTTP/HTTPS agents | `webfetch.test.ts`, `webfetch-native.test.ts` and compiled fixture |
| Rejected directory entries bypassed the pruning scan cap | Every visited entry charges the existing scan budget | `work-directory.test.ts`, three rejected-entry cases and a larger-budget control |
| Lockfile retained an older protobufjs after the override changed | Targeted lockfile refresh and a gate comparing every global override with all matching locked resolutions | `dependency-security-policy.test.mjs`, root/nested drift and similarly named package controls |

## Runtime and dependency decisions

Node 24.20.0 is the LTS development baseline; `.bun-version` pins standalone builds to Bun 1.4.2.
Direct dependencies are exact pins selected from nondeprecated stable releases older than the existing
two-day minimum age. Node types follow the Node 24 line. Transitive security overrides remain on their
consumers' compatible major lines. Dependency installation uses `--ignore-scripts`.

All 433 external lockfile artifact URLs and integrity values match npm registry metadata. Auditing
actual package manifests is necessary after a lockfile-only update: npm can update its hidden lock
while retaining old package files, so `npm ls` alone is insufficient evidence of installation.
The final clean `npm ci --ignore-scripts` installs protobufjs 7.6.6 and leaves all 320 present
package manifests consistent with the lockfile, with no required-package, peer, or engine mismatches.

The monorepo upgrade includes provider SDKs, Typebox, Vitest/Vite, Biome, syntax highlighting, and native
tool pins. SDK typing changes retain the shared service-tier contract and existing pricing policy.
The Codex adapter now uses its existing shared options builder. Biome upgrades prompted equivalent
optional guards, export ordering, and stronger assertions in existing tests; rules were not disabled.

jscpd 5.0.15 is the newest scanner version accepted by deterministic controls. Releases 5.0.16 through
5.1.2 report unrelated exported interfaces as clones. The regression includes real cross-format and
raw type-only clone controls; no production paths or thresholds were relaxed to hide that failure.

Managed provisioning pins now select [fd 10.5.0](https://github.com/sharkdp/fd/releases/tag/v10.5.0),
[uv 0.12.9](https://github.com/astral-sh/uv/releases/tag/0.12.9),
[Bitwarden CLI 2026.8.0](https://github.com/bitwarden/clients/releases/tag/cli-v2026.8.0), and
[Ollama 0.33.3](https://github.com/ollama/ollama/releases/tag/v0.33.3). The 17 changed fd/uv/Bitwarden
asset hashes match official release metadata; fd's Intel macOS target uses the same release again.
The Transformers installer pins Transformers 5.16.1, huggingface-hub 1.30.0, safetensors 0.8.0, and
PyTorch 2.14.0. PyPI dependency constraints and the official CPU wheel index were checked. Existing
global tools and model environments were not replaced. Real model inference was not exercised;
the published PyTorch wheels still do not provide current Intel macOS support.

At the owner's request, all four coordinator file ceilings are 4,000 lines. Extracted-owner markers
and forbidden-responsibility checks remain active. Further coordinator refactoring is deferred.

OpenCode's local checkout separates the Effect HTTP service from tool policy and bounded body reading.
Pi follows that architecture with stable Effect 3 packages. Its public-address policy requires a
different concrete transport: Bun 1.4.2 ignores `proxy: ""`, even in a worker with a separate environment.
Both proposed native-fetch paths were rejected after a hostile-proxy fixture reproduced the leak.
The maintained Effect Node HTTP adapter supplies direct scoped agents on both runtimes instead.

## Rejected candidates and limits

- Guessed paths, missing control arguments, and valid worker ownership refusals were user/tool-call
  mistakes, not independently reproduced harness defects.
- Bun's HTTPS server facade omits the SNI observation callback. A separate Node TLS server confirmed
  Bun's wire SNI; strict hostname and trust tests remain enabled on both runtimes.
- An HTTP 101 socket-leak candidate was rejected: a controlled upgraded connection closed after
  disposing the HTTP scope under both Node and Bun.
- The reported cross-session stall has no established root cause. Session control stores are scoped
  files and locks; the proposed shared SQLite explanation was unsupported.
- [Storage lifecycle](storage-lifecycle-design.md) is a completed design and acceptance plan. A cleanup
  CLI, asynchronous maintenance, continuation fairness, and SQLite migration remain proposed, with no
  claim of reclaimed disk space or measured latency improvement.
- Memory file locks coordinate cooperating writers; external editors can still race them. Different
  conflicting revisions stay retained. No live memory repair or deletion was performed.
- Provider compatibility tests use controlled responses. Credential-gated live-provider cases remain
  intentionally unexecuted; no paid API verification is claimed.
- Clean installation reports zero npm audit vulnerabilities and two upstream deprecation notices:
  `canvas` retains `prebuild-install`, and the Google authentication dependency chain retains
  `node-domexception`. Their current direct owners remain installed; lifecycle scripts were skipped.
- Native execution here is Linux evidence. The full non-e2e suite and supported release-platform matrix
  belong to GitHub Actions. Local checks alone do not establish a publishable release candidate.

## Verification entry points

The final local `npm run check` passes on the clean Node 24.20.0 installation. The production scan
covers all 933 eligible files out of 942 owned files, accounts for nine files below its minimum line
count, and reports zero clones. Focused session, worker, memory, runtime, and provider regressions
pass. WebFetch's native contract passes under Node, Bun source execution, and a freshly compiled
Bun 1.4.2 executable. The unreleased Workbench border/scrolling fixes are included in this candidate
and their focused rendering, cursor, resize, input, workspace, and projection suites pass.

Run `npm run check` with the pinned Node baseline. It owns formatting, dependency and test-harness
policy, standalone installer regressions, TypeScript, architecture, clone coverage, and browser import
checks. Run the specific test files above with `./test.sh <path>` or the package's targeted Vitest
command. The native HTTP fixture is also compiled and executed by binary CI. Do not replay the live
session or substitute a local full-suite run for required GitHub release evidence.
