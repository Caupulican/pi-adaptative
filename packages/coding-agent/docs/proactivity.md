# Proactivity

Pi can review an idle conversation for unfinished requests, risks, useful suggestions and reminders. The review is enabled by default, uses the session's model unless configured otherwise, and reads the recent conversation, current accepted owner knowledge, standing preferences and the goal's status and open requirements. Owner knowledge uses the same current records as ordinary requests and continuous chat, within a 2,000-character allowance. Internal and peer inputs are labeled separately from owner instructions.

The review has one tool, `raise_note`. It cannot run commands, inspect files, modify memory or contact anyone. Ordinary review text stays private to the review. The host drops empty or repeated notes and limits how many notes can be delivered.

By default, an accepted note starts a parent turn without waiting for another owner message. The parent handles it under the session's existing authority and budgets. Set `proactivity.delivery` to `"note"` to carry it with the owner's next turn instead. An explicit delivery choice is preserved. Scheduled routines and goal continuation are separate features.

Acceptance saves the note and its delivery mode in the session before reporting it as raised. Pending notes survive restart. Automatic delivery resumes through the parent-input ledger and does not inherit an unrelated active goal. Note-only delivery waits for an authenticated owner input; startup, internal turns and automatic work cannot consume it. A note is consumed only after its exact content reaches the selected request and that request receives a successful final provider response. Sending a request, a tool call or a failed response leaves it pending. This also applies to continuous chat.

Continuous chat records consumed background inputs as work history. On opening an older store, it hides obsolete background projections, verifies their original session evidence and rebuilds affected summaries. Original records keep their IDs and timestamps. Missing source evidence leaves the affected background record unavailable and reported for retry; ordinary history remains usable. Only proven consumption is restored, and excluded or forgotten sessions are not imported again.

A review retains the conversation branch, settings, goal and memory revision it started with. Foreground work, navigation, relevant settings changes or changed knowledge invalidate its result. Delivery checks those inputs again before entering the session. Each started review announces a raised, quiet or failed outcome. Cancellation or provider failure before acceptance discards captured notes; cancellation after a physical receipt does not undo that saved acceptance.

## Owner controls

- `/proactivity status` shows the resolved settings and the last reason a review did not start.
- `/proactivity off` disables idle reviews; `/proactivity on` enables them.
- `/proactivity prefs <text>` replaces the standing preferences.
- `/proactivity prefs clear` removes the standing preferences.
- `/proactivity review` requests a review immediately, subject to the remaining admission gates.

The root agent also has a `proactivity` tool with `view`, `set_preferences`, `clear_preferences`, `turn_on` and `turn_off` actions. It can use this when the owner asks to change what gets raised or how often they are interrupted. Each change displays the exact proposal and requires owner confirmation in the host UI. Without a UI, on cancellation or after a conflicting edit during confirmation, it changes nothing. An unrelated setting changed during confirmation is preserved. Workers cannot receive this tool, including through explicit grants.

Preferences are a whole document, limited to 2000 characters. The agent reads the existing document before proposing a replacement. An example is: `Raise unfinished work I asked for; avoid repeated reminders.`

## Scheduled work

The root agent's `routine` tool saves work for its owning session. It supports `create`, `list`, `get`, `update`, `pause`, `resume`, `delete` and `run`. A schedule is either one absolute UTC instant in epoch milliseconds (`{ "kind": "once", "at": ... }`) or an elapsed interval of at least ten seconds (`{ "kind": "interval", "intervalMs": ... }`). Calendar schedules and condition triggers are not supported yet.

Each routine retains its instructions, admitted worker profile and exact knowledge references. Later execution rechecks current authority and memory validity; saving a routine does not grant permanent access. It runs in an isolated worker and returns the result to the same parent session. Workers cannot create routines. Scheduled work does not acquire an unrelated goal that happens to be active later.

Updates require the current revision from `get` or `list`. Deleting and recreating a name never makes an old revision valid again. An occurrence already admitted retains its original instructions. A manual `run` has its own occurrence and leaves the scheduled slot intact, including when the schedule is paused. A later pause or deletion cancels occurrences that have not reached dispatch; work already dispatched retains its original intent and reports its outcome.

Occurrence claims and results are durable. Restart recovery reconciles the exact worker execution, and a dispatch whose outcome cannot be established is reported as uncertain instead of being repeated. If the exact worker later finishes, its confirmed outcome is delivered separately while the earlier uncertainty receipt is retained. A result is acknowledged only after the parent has durably accepted it. The parent's response is tracked separately, so a restart can resume an unhandled result without appending it twice.

The owning session must currently be running for execution. The bot daemon records due work but does not advance the schedule or execute a parent session in the background. Headless execution remains a separate missing capability.

## Limits

The defaults allow one review after two idle minutes, require three new owner turns between reviews, permit four reviews per running session and allow two notes per review. The review uses at most two provider requests. See the [settings reference](settings.md#proactivity) for all fields.

Before each review provider request, the host estimates the complete request cost, including tools and long-context pricing, and reduces the output allowance to fit the remaining `maxUsd`. If even one output token cannot fit, it sends no request. This is an estimate, not a guarantee of the provider's eventual bill; measured overspend stops further review requests and note delivery. `maxUsd` caps only the isolated review. A parent turn uses normal session accounting and budgets and can incur additional inference cost.

Custom models need declared prices for these background reviews. An explicitly configured zero price is valid; omitted prices are unknown and prevent a review request. Tiered prices use the same rate selection as measured usage.

The review reserves usage-journal capacity before starting. Each dispatched request retains its original accounting identity until the provider reports usage, including after cancellation. Cancellation can finish the review immediately while the provider request remains in flight; it does not release that request's accounting or admission capacity. Unresolved requests stay visible in the session journal with unknown usage, without an invented charge or automatic replay. Measured responses replace those entries and remain attributed to the starting session. Missing usage or failed receipt retention stops further spending. A restarted session starts a new per-session review count.
