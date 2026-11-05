# Proactivity

Pi can review an idle conversation for unfinished requests, risks, useful suggestions and reminders. The review is enabled by default, uses the session's model unless configured otherwise, and reads the recent conversation, current accepted owner knowledge, standing preferences and the goal's status and open requirements. Owner knowledge uses the same current records as ordinary requests and continuous chat, within a 2,000-character allowance. Internal and peer inputs are labeled separately from owner instructions.

The review has one tool, `raise_note`. It cannot run commands, inspect files, modify memory or contact anyone. Ordinary review text stays private to the review. The host drops empty or repeated notes and limits how many notes can be delivered.

By default, an accepted note accompanies the owner's next turn. Set `proactivity.delivery` to `"turn"` to have it start a parent turn. Scheduled routines and goal continuation are separate features.

A review retains the conversation branch, settings, goal and memory revision it started with. Foreground work, navigation, relevant settings changes or changed knowledge invalidate its result. Delivery checks those inputs again before entering the session. Each started review announces a raised, quiet or failed outcome; cancellation and provider errors never publish captured notes.

## Owner controls

- `/proactivity status` shows the resolved settings and the last reason a review did not start.
- `/proactivity off` disables idle reviews; `/proactivity on` enables them.
- `/proactivity prefs <text>` replaces the standing preferences.
- `/proactivity prefs clear` removes the standing preferences.
- `/proactivity review` requests a review immediately, subject to the remaining admission gates.

The root agent also has a `proactivity` tool with `view`, `set_preferences`, `clear_preferences`, `turn_on` and `turn_off` actions. It can use this when the owner asks to change what gets raised or how often they are interrupted. Each change displays the exact proposal and requires owner confirmation in the host UI. Without a UI, on cancellation or after a conflicting edit during confirmation, it changes nothing. An unrelated setting changed during confirmation is preserved. Workers cannot receive this tool, including through explicit grants.

Preferences are a whole document, limited to 2000 characters. The agent reads the existing document before proposing a replacement. An example is: `Raise unfinished work I asked for; avoid repeated reminders.`

## Limits

The defaults allow one review after two idle minutes, require three new owner turns between reviews, permit four reviews per running session and allow two notes per review. The review uses at most two provider requests. See the [settings reference](settings.md#proactivity) for all fields.

Before each provider request, the host estimates the complete request cost, including tools and long-context pricing, and reduces the output allowance to fit the remaining `maxUsd`. If even one output token cannot fit, it sends no request. This is an estimate, not a guarantee of the provider's eventual bill; measured overspend stops further requests and note delivery.

Custom models need declared prices for these background reviews. An explicitly configured zero price is valid; omitted prices are unknown and prevent a review request. Tiered prices use the same rate selection as measured usage.

The review reserves usage-journal capacity before starting. Every measured provider response is attributed to the starting session, including late responses after cancellation. Missing usage or failed receipt retention stops further spending. A restarted session starts a new per-session review count.
