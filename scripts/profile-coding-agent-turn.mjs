import { mkdirSync, writeFileSync } from "node:fs";
import inspector from "node:inspector";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { agentLoop } from "../packages/agent/src/agent-loop.ts";
import { createAssistantMessageEventStream } from "../packages/ai/src/utils/event-stream.ts";
import { createEmptyUsage } from "../packages/ai/src/usage.ts";
import { parseIntegerFlag, tryConsumeHelpFlag } from "./lib/cli-flags.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultProfileDir = join(repoRoot, "profiles-node");

function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-turn.mjs [options]

Profiles the agent-core loop's PER-TURN host work (remediation item D2), not process startup -
that is what scripts/profile-coding-agent-node.mjs already covers. This script drives
packages/agent's agentLoop directly against a STUB/SCRIPTED provider stream (no network, no real
provider, no packages/coding-agent session) through a scripted sequence of tool calls, over as many
turns as you ask for, and profiles ONLY that loop.

Why a stub stream: the point is to isolate HOST work from provider network time. A real provider
adds seconds of network latency per turn that would swamp the CPU profile; a real coding-agent
session would add its own startup and provider-selection cost on top of that. Driving agentLoop
directly, with a stub stream that resolves near-instantly, means almost all measured wall time here
IS host CPU work.

Why this exists: two open findings (C1, C2) show packages/coding-agent's task_steps tool degrading
from a 25ms p50 early in a session to 422ms late in the SAME session (get_goal: 10ms to 77ms), while
other tools (read/edit/memory) stay flat at 24-35ms. Every other suspect has already been cleared by
measurement: session-store appends (0.02ms), branch snapshot lookups (0.007ms), the tool's own
execute() (0.005-0.11ms even at 200 steps), concurrency, result payload size, and the error path.
The residual is somewhere in the host event pipeline around each tool call, and closing it needs a
real per-turn profile - which is what this script produces. It does NOT attempt to fix C1/C2; it is
the instrument only.

The effect this is hunting for only shows up LATE in a session (it is a function of how much the
loop has already done, not of any one call in isolation), so a short run will show nothing - use
--turns high enough to matter (hundreds, not tens) when actually investigating C1/C2.

Options:
  --turns <n>            Number of scripted tool-call turns to run before a final tool-free closing
                          turn (default: 300). Every turn calls the same synthetic tool once, so the
                          transcript grows by ~2 messages per turn (assistant + tool result) exactly
                          like a real session repeatedly calling one tool.
  --profile-dir <dir>    CPU profile output directory (default: profiles-node, same as the startup
                          profiler - both write plain V8 .cpuprofile files).
  --label <name>          Profile file name prefix (default: turn-profile)
  --help                 Show this help

Output:
  - A .cpuprofile file in --profile-dir, in the exact format Node's own --cpu-prof flag writes (V8
    Profiler.stop() output) - the same format scripts/profile-coding-agent-node.mjs already
    produces, so existing analysis habits carry over unchanged.
  - A turn-duration-by-session-decile table printed to stdout: the --turns scripted turns are split
    into 10 equal-sized buckets in ORIGINAL ORDER (decile 1 = the first tenth of turns run, decile
    10 = the last tenth), and each bucket's MEDIAN turn duration is printed. A flat table across
    deciles means no session-growth effect was reproduced. A table that RISES from decile 1 to
    decile 10 is exactly the shape task_steps/get_goal showed in the real corpus, and confirms this
    run caught it - go read the .cpuprofile for where the time went. A second table breaks the same
    turns down by tool_execution_start -> tool_execution_end specifically, isolating tool dispatch
    from the rest of the turn (message streaming, event emission, etc).
  - METRIC lines (turn_count, turn_duration_first_ms, turn_duration_last_ms) for scripted comparison
    across runs, matching the METRIC convention in profile-coding-agent-node.mjs.

How to read the .cpuprofile:
  - Chrome DevTools: open chrome://inspect, "Open dedicated DevTools for Node", Profiler tab, Load,
    pick the file. Use the Bottom-Up view and sort by Self Time to find which function is actually
    burning CPU, not just which one appears most often on the stack.
  - speedscope (no Chrome needed): npx speedscope <path-to-.cpuprofile>, then use the "left heavy"
    view for the same self-time-first triage.
  - Because the whole run uses a stub stream, there is no real network frame to filter out first -
    almost everything in the profile IS host work; do not discount a frame as "probably just waiting
    on the provider" the way you would with a live-provider profile.

Example:
  node scripts/profile-coding-agent-turn.mjs --turns 800
`);
}

function parseArgs(argv) {
	const options = {
		turns: 300,
		profileDir: undefined,
		label: "turn-profile",
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (tryConsumeHelpFlag(arg, options)) continue;

		if ((arg === "--turns" || arg === "--profile-dir" || arg === "--label") && index + 1 >= argv.length) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--turns") {
			options.turns = parseIntegerFlag(argv[++index], "--turns", { min: 1 });
			continue;
		}

		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

function createStubModel() {
	return {
		id: "turn-profile-stub",
		name: "turn-profile-stub",
		api: "openai-responses",
		provider: "stub",
		baseUrl: "https://stub.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 8_192,
	};
}

function createAssistantMessage(model, content, stopReason) {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createEmptyUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

/**
 * Synthetic stand-in for a frequently-called tool (task_steps/get_goal are the real ones that
 * degrade). Its own execute() is deliberately trivial: C1 already cleared the real tools' own
 * execute() bodies as a cause (0.005-0.11ms even at 200 steps), so any cost this profile attributes
 * to the surrounding host pipeline - preparation, reservation, event emission, message bookkeeping -
 * is not coming from tool logic, real or stubbed.
 */
const stubTool = {
	name: "stub_tool",
	label: "Stub Tool",
	description: "Synthetic per-turn profiling tool. See scripts/profile-coding-agent-turn.mjs.",
	parameters: Type.Object({ step: Type.Number() }),
	async execute(_toolCallId, params) {
		// Deliberately >= 64 chars: tool-failure-memory.ts's payload-based dedup signature
		// (fastTextSignature) only runs above that length, and a short result would silently
		// leave that path unprofiled.
		return {
			content: [{ type: "text", text: `stub step ${params.step} completed successfully with no errors to report` }],
			details: { step: params.step },
		};
	},
};

function identityConverter(messages) {
	return messages.filter((message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult");
}

function createUserMessage(text) {
	return { role: "user", content: text, timestamp: Date.now() };
}

/** One scripted tool call per turn for `turns` turns, then one tool-free closing turn. */
function createScriptedStreamFn(turns) {
	let turnIndex = 0;
	return (model) => {
		const stream = createAssistantMessageEventStream();
		const thisTurn = turnIndex;
		turnIndex++;
		queueMicrotask(() => {
			const message =
				thisTurn < turns
					? createAssistantMessage(
							model,
							[{ type: "toolCall", id: `call-${thisTurn}`, name: "stub_tool", arguments: { step: thisTurn } }],
							"toolUse",
						)
					: createAssistantMessage(model, [{ type: "text", text: "Scripted profiling session complete." }], "stop");
			stream.push({ type: "done", reason: message.stopReason, message });
		});
		return stream;
	};
}

/**
 * Drives one full scripted session through agentLoop, recording wall-clock duration for every turn
 * (turn_start -> turn_end, which spans message streaming AND tool execution) and for every
 * individual tool call (tool_execution_start -> tool_execution_end) along the way.
 */
async function runScriptedSession(turns) {
	const model = createStubModel();
	const context = { systemPrompt: "You are a per-turn profiling harness.", messages: [], tools: [stubTool] };
	const config = { model, convertToLlm: identityConverter };
	const streamFn = createScriptedStreamFn(turns);

	const perTurn = [];
	const perToolCall = [];
	const toolStartedAt = new Map();
	let turnNumber = 0;
	let turnStartedAt;
	let messageCountAtTurnStart = 0;

	const stream = agentLoop(
		[createUserMessage("Begin the scripted profiling session.")],
		context,
		config,
		undefined,
		streamFn,
	);
	for await (const event of stream) {
		if (event.type === "turn_start") {
			turnNumber++;
			turnStartedAt = performance.now();
			messageCountAtTurnStart = context.messages.length;
			continue;
		}
		if (event.type === "turn_end") {
			if (turnStartedAt !== undefined) {
				perTurn.push({
					turnNumber,
					durationMs: performance.now() - turnStartedAt,
					messageCountAtStart: messageCountAtTurnStart,
				});
			}
			continue;
		}
		if (event.type === "tool_execution_start") {
			toolStartedAt.set(event.toolCallId, performance.now());
			continue;
		}
		if (event.type === "tool_execution_end") {
			const startedAt = toolStartedAt.get(event.toolCallId);
			if (startedAt !== undefined) {
				perToolCall.push({ turnNumber, toolCallId: event.toolCallId, durationMs: performance.now() - startedAt });
				toolStartedAt.delete(event.toolCallId);
			}
		}
	}

	return { perTurn, perToolCall };
}

function startCpuProfile() {
	const session = new inspector.Session();
	session.connect();
	return new Promise((resolvePromise, reject) => {
		session.post("Profiler.enable", (enableError) => {
			if (enableError) {
				reject(enableError);
				return;
			}
			session.post("Profiler.start", (startError) => {
				if (startError) {
					reject(startError);
					return;
				}
				resolvePromise(session);
			});
		});
	});
}

function stopCpuProfile(session) {
	return new Promise((resolvePromise, reject) => {
		session.post("Profiler.stop", (error, result) => {
			session.disconnect();
			if (error) {
				reject(error);
				return;
			}
			resolvePromise(result.profile);
		});
	});
}

/** Splits `entries` (already in original run order) into 10 equal-sized buckets and medians each. */
function summarizeDeciles(entries, valueOf) {
	const deciles = [];
	for (let decile = 0; decile < 10; decile++) {
		const start = Math.floor((entries.length * decile) / 10);
		const end = Math.floor((entries.length * (decile + 1)) / 10);
		const bucket = entries.slice(start, end);
		if (bucket.length === 0) continue;
		const values = bucket.map(valueOf).sort((a, b) => a - b);
		const mid = Math.floor(values.length / 2);
		const medianMs = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2 : values[mid];
		deciles.push({ decile: decile + 1, count: bucket.length, medianMs });
	}
	return deciles;
}

function writeDecileTable(label, entries, valueOf) {
	process.stdout.write(`\n${label}\n`);
	if (entries.length === 0) {
		process.stdout.write("  (no data)\n");
		return;
	}
	for (const bucket of summarizeDeciles(entries, valueOf)) {
		process.stdout.write(`  decile ${bucket.decile}/10  n=${String(bucket.count).padStart(5)}  median=${bucket.medianMs.toFixed(2)}ms\n`);
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	const profileDir = options.profileDir ?? defaultProfileDir;
	mkdirSync(profileDir, { recursive: true });
	const profilePath = join(profileDir, `${options.label}.cpuprofile`);

	process.stdout.write(`Running ${options.turns} scripted turns against a stub provider stream (no network)...\n`);

	const session = await startCpuProfile();
	const startedAt = performance.now();
	const { perTurn, perToolCall } = await runScriptedSession(options.turns);
	const elapsedMs = performance.now() - startedAt;
	const profile = await stopCpuProfile(session);
	writeFileSync(profilePath, JSON.stringify(profile));

	process.stdout.write(
		`\nCompleted ${perTurn.length} turns in ${elapsedMs.toFixed(1)}ms (${(elapsedMs / Math.max(perTurn.length, 1)).toFixed(2)}ms/turn avg)\n`,
	);
	process.stdout.write(`CPU profile: ${toDisplayPath(profilePath)}\n`);

	writeDecileTable(
		"Turn duration by session decile (turn_start -> turn_end; host time, provider wait is near-zero with the stub stream):",
		perTurn,
		(entry) => entry.durationMs,
	);
	writeDecileTable(
		"stub_tool execution duration by session decile (tool_execution_start -> tool_execution_end):",
		perToolCall,
		(entry) => entry.durationMs,
	);

	const first = perTurn[0];
	const last = perTurn[perTurn.length - 1];
	process.stdout.write(`\nMETRIC turn_count=${perTurn.length}\n`);
	if (first) process.stdout.write(`METRIC turn_duration_first_ms=${first.durationMs.toFixed(2)}\n`);
	if (last) process.stdout.write(`METRIC turn_duration_last_ms=${last.durationMs.toFixed(2)}\n`);
}

main().catch((error) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exit(1);
});
