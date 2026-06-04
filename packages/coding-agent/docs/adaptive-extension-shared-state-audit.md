# Pi adaptive extension shared-state audit

Date: 2026-06-04
Scope: `~/.pi/agent/extensions`, TypeScript sources, excluding `node_modules`, `dist`, `build`, `.git`, and coverage folders.

## Classification legend

- **Tenant-scoped**: mutable state is under a current session/tenant key; tools should not list or mutate other tenants by default.
- **User-global guarded**: state is intentionally shared across Pi sessions because it represents a user-level transport, daemon, or coordinator. The extension must document this and guard mutating actions.
- **Utility/no durable mutable state**: no relevant shared durable state, or only bounded artifacts with no session/task ownership implications.

## Audit table

| Extension/file | Shared artifacts found | Classification | Status / evidence |
| --- | --- | --- | --- |
| `harness-stack/index.ts` | Previously global `tasks.json`, `team-peers.json`, `team-agent-runs/`, `runs/`; global UI preset `state.json` remains. | Tenant-scoped for orchestration; user-global for UI preset only. | Patched to `~/.pi/agent/harness-stack/tenants/<tenant-id>/...`. Behavioral two-session proof: `/tmp/harness-stack-isolation-check.mjs` PASS, cross-session task/binding invisibility and no global task/run artifacts. |
| `task-scheduler/index.ts` | Previously global `jobs.json`, `runs/`, `logs/`, `output/`, `tick.lock`. | Tenant-scoped. | Patched to `~/.pi/agent/task-scheduler/tenants/<tenant-id>/...`. Behavioral two-session proof: `/tmp/task-scheduler-isolation-check.mjs` PASS; cross-session status/pause/remove blocked as not found. |
| `task-steps/index.ts` | `task-steps/tenants/<tenant>/state.json`, background jobs/logs/output. | Tenant-scoped. | Already hardened before this round; tool descriptions say current-session tenant only. |
| `subagent/index.ts` | `subagent-background/sessions/<tenant>/...`, `subagent-runs/sessions/<tenant>/...`, persistent user/project agent dirs. | Tenant-scoped for runs; user/project agent dirs are deliberate durable assets. | Already hardened before this round; `agent_runtime` only lists/controls current-session tenant runs and prune requires sweep+memory evidence. |
| `continuous-learning/index.ts` | Auto-learn state/lock, run logs, per-tenant learner artifacts, Automata writes. | Mixed: tenant-scoped artifacts/concurrency; user-global learner lease is deliberate coordination. | Already patched before this round for per-session tenant artifact dirs, per-tenant concurrency, prompt/log cleanup, and memory-first validation tree. |
| `adaptative-agent/index.ts` | Adaptive work/truth/renewal state, reload coordinator awareness. | User-global adaptive coordinator with guardrails. | Previously patched: auto-learn sessions ignored in reload blockers; adaptive state records evidence and renewal requires judged packets/source audit. |
| `pi-auto-reload/index.ts` | `pi-auto-reload-state.json/.lock`, `pi-active-turns.json/.lock`, handoff/config. | User-global guarded coordinator. | Intentional cross-session reload coordination so sessions do not reload over active foreground turns; README updated to document global coordinator files and auto-learn exclusion. |
| `pi-chat/*` | `~/.pi/pi-chat/config.json`, `identity.json`, `peers.json`, `devices.json`, `sessions/local/audit.jsonl`, pairing QR artifacts, socket/relay runtime. | User-global guarded transport endpoint. | Inspected constants/state/tools/commands/local-mesh/qrcode. README/tool guidelines/status/setup text updated: user-global transport state, metadata-only audit, no message body persistence, token-gated TCP, no shell execution. |
| `mobile-gateway/index.ts`, `mobile-gateway/daemon.cjs` | `~/.pi/agent/mobile-gateway/runtime.json`, `daemon.log`, Telegram offset, WhatsApp session/QR files, daemon process. | User-global guarded singleton. | Patched: start records owner tenant/session, daemon persists owner metadata, status/logs expose `singletonScope=user-global`, cross-tenant stop refuses unless `confirm=yes-stop-global-mobile-gateway`. Behavioral guard proof: `/tmp/mobile-gateway-singleton-guard-check.mjs` PASS. |
| `pi-chat/src/qrcode.ts` | Pairing QR `.svg/.txt` under pi-chat pairing dir. | User-global guarded artifact. | Artifacts contain short-lived pairing URI/token, private mode best-effort; documented under pi-chat transport guardrails. |
| `mobile-gateway/README.md`, `pi-chat/README.md`, `pi-auto-reload/README.md` | Documentation state. | Guardrail documentation. | Updated to make deliberate global/singleton behavior auditable for future agents. |
| `bash-guard/index.ts` | No durable mutable state. | Utility/no durable mutable state. | Pattern hits were static block-rule names, not shared files. |
| `ask-user-question.ts` | No durable mutable state found. | Utility/no durable mutable state. | UI question helper; no cross-tenant file store. |
| `context.ts`, `learning-review.ts`, `md-link.ts`, `lib/context-limits.ts` | No high-risk shared runtime state found in audit; bounded helper behavior. | Utility/no durable mutable state or read-only/helper artifacts. | No patch needed from this sweep. |
| `antigravity-ui/index.ts`, `web-fetch/index.ts`, `web-search/index.ts`, `google-image-search/index.ts`, `youtube-search/index.ts`, `video-extract/index.ts`, `trello/index.ts`, `rg-tool.ts` | No high-risk shared session/task state found in TypeScript audit. | Utility/no durable mutable state. | No patch needed from this sweep. |

## Validation evidence

- Harness-stack behavioral isolation: `node /tmp/harness-stack-isolation-check.mjs` -> PASS.
- Task-scheduler behavioral isolation: `node /tmp/task-scheduler-isolation-check.mjs` -> PASS.
- Mobile-gateway singleton guard: `node /tmp/mobile-gateway-singleton-guard-check.mjs` -> PASS.
- Focused extension builds: `esbuild` passed for `harness-stack`, `task-scheduler`, `mobile-gateway`, and `pi-chat`.
- Core prompt behavior source/test: MAPE + tenant-safety + Automata-memory guardrails added to `packages/coding-agent/src/core/system-prompt.ts`; `packages/coding-agent/test/system-prompt.test.ts` covers them.
- Full repo validation previously passed after prompt changes: `npm run check`.

## Runtime activation note

The authorized source repo `/mnt/d/GitHub/mine/pi-adaptative` has the updated prompt source and built source `packages/coding-agent/dist/core/system-prompt.js` contains the new rules after `npm run build`. The global `pi` package was relinked with `npm link` from `/mnt/d/GitHub/mine/pi-adaptative/packages/coding-agent`; `readlink -f $(which pi)` now resolves to `/mnt/d/GitHub/mine/pi-adaptative/packages/coding-agent/dist/cli.js`, and the global package path `/home/caudev/.nvm/versions/node/v22.22.3/lib/node_modules/@caupulican/pi-adaptative` resolves to the authorized source package. The active global runtime `dist/core/system-prompt.js` contains the MAPE, tenant-safety, and Automata-memory prompt lines for new Pi sessions.
