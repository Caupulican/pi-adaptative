# Does delegation earn its cost?

The coding evaluator compares two Pi SDK sessions on identical starting repositories. The direct session completes the task with file tools. The automatic session also has Pi's delegation and worktree tools and decides whether to use them. A case passes when the independent grader accepts the resulting checkout or answer. A worker's own verdict is recorded separately.

## Run from the source checkout

Print the cases, prompts, and execution order offline.

```sh
npm run eval:coding
```

A live run uses provider quota. Supply the exact foreground model and a fresh output directory outside Pi’s private agent directory whose parent exists. For example, with an environment variable containing your chosen provider/model reference, run three repetitions of the cross-module repair.

```sh
npm run eval:coding -- --run --model "$PI_EVAL_MODEL" --case event-adapters --repetitions 3 --out ./adapter-study
```

Both arms start with the same pinned foreground model at its lowest supported thinking level by default. Use `--thinking` to request another supported level in both arms. By default workers use that model too. With `--account-routing`, Pi can choose among the trial's authenticated accounts. Repeat `--candidate provider/model` to give routes preference within that mode. Other authenticated subscriptions can be selected. Add `--hosted-only` to exclude local inference. Each trial records the available catalog and observed models. For a separate startup diagnostic, `--probe-worker provider/model` tells the automatic arm to start a worker pinned to that model and await its report. Its results measure requested delegation. Use a separate output directory from the free-choice study. The root SDK reads credentials and custom model definitions from the caller's Pi configuration. Use a model that supports tools and worker lanes.

System One is disabled by default to isolate the effect of offering workers. `--system-one` enables its automatic provider selection in both arms and can consume additional quota. The fixture omits owner extensions, skills, project instructions, and scheduled routines. The root has the same file tools in each arm. Workers use their native execution contracts. Provider availability, quotas, and server-side caches can vary between arms.

## What the cases measure

| Case | Independent acceptance check |
| --- | --- |
| `slugify` | Execute the exported function on punctuation and whitespace examples and check the requested JSDoc. |
| `retry-migration` | Check the schema and both configurations for renamed fields, preserved values, and the zero override. |
| `trace-override` | Check a structured diagnosis across three files and verify that their contents stayed intact. |
| `event-adapters` | Exercise two event adapters, feed their results through the reducer in opposing arrival orders, and check ties, replay, and empty input. |

Every arm gets its own Git repository, session, and agent directory. Its worktree landing gate runs `git diff --check` against the seed commit to catch whitespace errors and newly introduced conflict markers. The first arm alternates across cases and repetitions. After foreground and worker activity settles, each failed submission gets the same grader feedback protocol. `--max-corrections` sets the number of feedback turns allowed, with a default of one. These counts estimate owner rework through scripted feedback. Human effort requires a separate observation.

## Read the report

`plan.json` identifies the source revision, dirty state, corpus digest, model configuration, prompts, and trial order. `report.json` is replaced atomically as work progresses. It contains an active trial checkpoint, per-arm totals, completed pairs, and individual trial results with the grade for each submission. Each trial directory retains the submitted checkout and Pi session evidence. Use a fresh output directory for a new run.

- Compare first-pass and eventual acceptance, corrections, and actual worker attempts. An automatic session may legitimately finish a task itself.
- Cost per accepted task divides total API-equivalent spend across all finished trials in an arm, including rejected submissions, by the number accepted. The figure requires a complete arm and complete pricing. A null price means the total is unknown. Trial rows retain observed costs, model usage, and worker outcomes. API-equivalent USD measures usage at model rates. A subscription invoice can differ.
- Elapsed time starts before fixture preparation and ends after SDK teardown or process termination. Elapsed time per accepted task includes time spent on failures. Pair deltas subtract the direct value from the automatic value. A timeout measures time to the cutoff. `--timeout-ms` sets the per-session deadline after fixture setup, five minutes by default.
- Rejections, errors, timeouts, and interruptions remain visible. The command exits nonzero if any completed trial failed acceptance or the run stopped early. Persistent report coverage distinguishes an interrupted study from a completed one.

The plan and report carry a SHA-256 fingerprint of the checkout’s package sources, package manifests and lockfile, vendored files, evaluator and grading helpers. This includes new source files visible to Git. The driver compares that fingerprint again at the end of a study and marks a changed checkout with a nonzero exit. Account state, installed dependencies and provider behavior have separate lifetimes.

Four small cases establish a reproducible starting point for comparing coding workflows. They do not establish a whole-product reliability score, a human correction rate, or a stable cross-provider ranking. Interpret differences alongside case mix, repetitions, and observed worker use.

## Hosted baseline on 2026-11-19

Each row covers two repetitions of the four cases. Both arms in each profile used the same foreground Codex model. The controlled profile used low thinking, pinned workers and disabled System One. The adaptive profile used high thinking, System One and authenticated hosted worker routing. Compare arms within a profile.

| Profile | Arm | First-pass accepts | Seconds per acceptance | API-equivalent USD per acceptance |
| --- | --- | ---: | ---: | ---: |
| Controlled | Direct | 8/8 | 27.0 | 0.081 |
| Controlled | Automatic | 8/8 | 84.7 | 0.220 |
| Adaptive | Direct | 8/8 | 37.0 | 0.068 |
| Adaptive | Automatic | 6/8 | 279.8 | Incomplete |

Both adaptive timeouts occurred on the cross-module repair at the five-minute cutoff. The elapsed figure includes both failures. All 11 automatic trials that requested a worker got a worker response on their first launch request. Three later requests encountered a busy specialist. Median time from request to first completed worker response was 3.83 seconds in the controlled profile and 3.97 seconds in the adaptive profile.

In the second adaptive cross-module trial, a worker read the evaluator source outside its checkout before editing. Treat the table as an operational baseline. That trial cannot be used as a blind measure of model quality. Later runs should record the scoped session's worker grants alongside their results.

Two further matched repetitions of the cross-module repair used the same high-effort root and Flash High worker route, with the SDK worker ceiling repaired. Both direct runs passed on their first submission (91.1 and 68.4 seconds). Both automatic runs started workers on the first request and reached the 300-second cutoff without a worker edit. The worker tool results show out-of-scope reads were refused. The first file search took 21 and 41 seconds respectively, and a managed `fd` appeared in each fresh agent directory as that search finished. Other long intervals occurred after a model request started. The transcripts do not identify what happened inside the provider during those intervals.

### Flash Low and worker integration

With Flash Low first in the account routing order, a further automatic run edited the modules but reached the cutoff during worktree integration. Two matched repetitions then produced one first-pass automatic acceptance in 271 seconds and one timeout. The corresponding direct runs passed in 67 and 57 seconds.

A CPU profile caught the native finder calling Node's synchronous diagnostic report to identify glibc. With active provider sockets this blocked the event loop for 10 seconds in a direct trial and 40 seconds in an automatic trial. The loader now excludes network details for that synchronous check. A fresh matched pair after the change passed on first submission in 65 seconds direct and 171 seconds automatic. Neither arm crossed the profiler's 1.75-second sampling threshold for a stall.

In the timed-out repetition, both worker branches landed and passed their configured gates. The root reported completion at 249 seconds. The final-answer verifier then challenged its file-change claim because it had missed the landing receipts. An independent regrade of the checkout after timeout found no issues. The timed result remains a failure. The verifier now reads the paths recorded by a successful landing, the outcome of a typed lane commit, and the configured gate result. A generic gate supplies non-test evidence.

With landing receipts enabled, the final two matched repetitions both passed on first submission. Direct took 57.1 and 55.3 seconds ($0.158 and $0.122 API-equivalent). Automatic took 262.9 and 208.1 seconds ($0.703 and $0.875). Both automatic trials used subscription Flash Low. All five fresh worker requests returned worker output, with a median 1.22 seconds to acknowledgment and 3.76 seconds to the first completed worker response. The root first requested delegation after three and four prior root responses. There was one recorded worker error before first output across the twelve attempt boundaries, including follow-ups. A first-request launch is distinct from a retry within a worker. The repaired path completed this task reliably in these two observations, at higher latency and cost than direct work.

### November 20 working-tree calibration

Two private studies used the same OpenRouter GPT-6 Luna model, low thinking, live Jev and no correction prompts. Each study ran one matched pair per case. The independent grader accepted all eight submissions on the first attempt. Elapsed seconds include preparation and teardown. Costs are API-equivalent USD.

| Task and study | Direct seconds | Automatic seconds | Direct USD | Automatic USD | Worker attempts in automatic arm |
| --- | ---: | ---: | ---: | ---: | ---: |
| Slugify, before repair | 15.57 | 58.14 | 0.000789 | 0.004666 | 2 |
| Slugify, after repair | 21.74 | 15.73 | 0.001165 | 0.001147 | 0 |
| Event adapters, before repair | 19.29 | 69.55 | 0.001323 | 0.007147 | 2 |
| Event adapters, after repair | 36.01 | 21.79 | 0.001963 | 0.001623 | 0 |

Before repair the default director prompt told the root to give task execution to a worker even with strict delegation switched off. In the first Slugify trial a worker tried to read an absolute path in the parent checkout and reported a blocker. The root started a second attempt using the relative path. The repaired director prompt follows the configured delegation gate. A refused worker read now suggests the corresponding file in its own worktree when that file exists and passes the worker's read grant and private-path checks. The nine focused path regressions exercised the hint. In the second live study both automatic trials chose direct execution, so that study measures the routing change. It provides no estimate of time saved by the path hint. Each study retained a stable measured-source SHA-256, respectively `a5cd2f7714d10d6cb429b8d314e37f4d985f3a45c6e7e7efd2fa9af7ff446150` and `dc5e7ac8e27021a0e0d7cc9632950fd405ca425f1b2b28c754b7c36966f5d71e`.

The initial Gemini Flash Lite control on OpenRouter had three trial errors and a rejected direct event-adapters submission. A separate Slugify diagnostic produced one direct error and one rejected automatic submission. Provider traces included HTTP 429 and 502 errors. Pricing was incomplete on errored trials. Each case and arm above had one observation per study. A benefit from delegation on a larger task and post-repair steering frequency in ordinary use remain unmeasured.

A second repaired snapshot added one matched pair on each remaining corpus case using the same model, low effort and zero correction prompts. Retry migration took 20.10 seconds direct ($0.001453) and 17.59 seconds automatic ($0.001423). Tracing the override took 12.12 seconds direct ($0.000695) and 10.69 seconds automatic ($0.001068). All four submissions passed on the first attempt. Neither automatic run used a worker. The measured source hash stayed `c242d7e7308bbe714734b11a19f298359a5acd935c60823f180b00881db52708` throughout this study.

### November 21 local coding check with thinking off

A CPU-only LFM3 1.7B model attempted Slugify once per arm in direct and automatic mode before and after the file-refusal repair. Jev was disabled. Each arm received the same 210-second limit and zero owner corrections. The independent grader rejected all four worktrees because `util.ts` still contained the seed implementation. On the repaired build the direct arm read the correct file. The automatic arm received the new refusal, continued using an outside path and sent malformed edit arguments. The original request already contained the checkout and listed `util.ts`. The result covers this model, task and time limit. [Measured runs and receipts](../../../docs/SYSTEM_INTERACTIONS.md#refused-file-operations-in-a-local-coding-task-november-21)
