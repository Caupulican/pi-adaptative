import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";

import { readJsonIfExists, startPiAcceptanceRpc } from "./lib/live-acceptance-rpc.mjs";
import { assistantReportedToolMarker, failedToolResult, successfulToolResults } from "./lib/live-tool-results.mjs";

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function createFakeChild() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	child.killedWith = [];
	child.kill = (signal) => {
		child.killedWith.push(signal);
		return true;
	};
	return child;
}

test("RPC acceptance streams fragmented JSON lines once and preserves process ownership", async () => {
	const child = createFakeChild();
	const calls = [];
	let stderr = "";
	const client = startPiAcceptanceRpc({
		root: "/repo",
		provider: "provider",
		model: "model",
		agentDir: "/agent",
		sessionDir: "/sessions",
		timeoutMs: 1_000,
		stderr: { write: (chunk) => (stderr += chunk) },
		spawnProcess: (...args) => {
			calls.push(args);
			return child;
		},
	});

	assert.deepEqual(calls[0][1], [
		"--mode",
		"rpc",
		"--provider",
		"provider",
		"--model",
		"model",
		"--session-dir",
		"/sessions",
		"--system-prompt",
		"",
		"--no-extensions",
	]);
	assert.equal(calls[0][2].env.PI_CODING_AGENT_DIR, "/agent");
	assert.equal(calls[0][2].env.PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR, "/sessions");

	const marker = "x".repeat(256 * 1024);
	const line = JSON.stringify({ id: "fragmented", type: "response", marker });
	const pending = client.waitForEvent((event) => event.id === "fragmented", "fragmented response");
	child.stdout.write("null\nnot-json\n");
	for (let offset = 0; offset < line.length; offset += 31) child.stdout.write(line.slice(offset, offset + 31));
	child.stdout.write("\n");
	const event = await pending;
	assert.equal(event.marker, marker);

	let command = "";
	child.stdin.setEncoding("utf8");
	child.stdin.on("data", (chunk) => {
		command += chunk;
	});
	client.send({ id: "command", type: "get_state" });
	assert.equal(command, '{"id":"command","type":"get_state"}\n');
	child.stderr.write("diagnostic");
	assert.equal(stderr, "diagnostic");

	client.close();
	assert.equal(child.stdin.writableEnded, true);
	assert.deepEqual(child.killedWith, ["SIGTERM"]);
});

test("RPC acceptance rejects an over-limit unterminated line without flattening it", async () => {
	const child = createFakeChild();
	const client = startPiAcceptanceRpc({
		root: "/repo",
		provider: "provider",
		model: "model",
		agentDir: "/agent",
		sessionDir: "/sessions",
		timeoutMs: 1_000,
		maxLineCharacters: 32,
		stderr: { write: () => undefined },
		spawnProcess: () => child,
	});
	const pending = client.waitForEvent(() => false, "bounded line");
	child.stdout.write("a".repeat(33));
	await assert.rejects(pending, /exceeded 32 characters/);
	client.close();
});

test("shared JSON reads distinguish a missing file from malformed persisted state", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-live-acceptance-"));
	temporaryDirectories.push(directory);
	assert.deepEqual(await readJsonIfExists(path.join(directory, "missing.json")), {});
	const filePath = path.join(directory, "state.json");
	await writeFile(filePath, '{"ok":true}', "utf8");
	assert.deepEqual(await readJsonIfExists(filePath), { ok: true });
	await writeFile(filePath, "not-json", "utf8");
	await assert.rejects(readJsonIfExists(filePath), SyntaxError);
});

test("live workflow counts each logical tool execution once", () => {
	const successfulResult = {
		type: "tool_execution_end",
		toolCallId: "text-tool-1",
		toolName: "write",
		isError: false,
		result: { details: { phase: "prepared", intentId: "intent" } },
	};
	const duplicateMessage = {
		type: "message_end",
		message: {
			role: "toolResult",
			toolCallId: "text-tool-1",
			toolName: "write",
			isError: false,
			content: [{ type: "text", text: "prepared" }],
		},
	};
	const failedResult = {
		type: "tool_execution_end",
		toolCallId: "text-tool-2",
		toolName: "write",
		isError: true,
		result: { content: [{ type: "text", text: "failed" }] },
	};

	assert.deepEqual(successfulToolResults([successfulResult, duplicateMessage], "write"), [successfulResult]);
	assert.equal(failedToolResult([successfulResult, duplicateMessage], "write"), undefined);
	assert.equal(failedToolResult([successfulResult, duplicateMessage, failedResult], "write"), failedResult);
});

test("live workflow accepts a guarded phone repeat only after the original success and later progress", () => {
	const firstStart = {
		type: "tool_execution_start",
		toolCallId: "text-tool-1",
		toolName: "read",
		args: { path: "marker.txt" },
	};
	const firstSuccess = {
		type: "tool_execution_end",
		toolCallId: "text-tool-1",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "marker" }] },
	};
	const repeatStart = {
		type: "tool_execution_start",
		toolCallId: "text-tool-2",
		toolName: "read",
		args: { path: "marker.txt" },
	};
	const guardedRepeat = {
		type: "tool_execution_end",
		toolCallId: "text-tool-2",
		toolName: "read",
		isError: true,
		result: {
			details: {
				piToolFailureDirective: {
					failureCode: "repeated_successful_call",
				},
			},
		},
	};
	const recovered = {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "marker" }],
		},
	};

	assert.equal(
		failedToolResult([firstStart, firstSuccess, repeatStart, guardedRepeat, recovered], "read"),
		undefined,
	);
	assert.equal(failedToolResult([firstStart, firstSuccess, repeatStart, guardedRepeat], "read"), guardedRepeat);
	assert.equal(failedToolResult([repeatStart, guardedRepeat, recovered], "read"), guardedRepeat);
	assert.equal(
		failedToolResult(
			[
				{ ...firstStart, args: { path: "different.txt" } },
				firstSuccess,
				repeatStart,
				guardedRepeat,
				recovered,
			],
			"read",
		),
		guardedRepeat,
	);
});

test("live workflow follows explicit repeat linkage when a completed mutation changes payload form", () => {
	const firstStart = {
		type: "tool_execution_start",
		toolCallId: "write-1",
		toolName: "write",
		args: { action: "write", path: "same.txt", content: "bytes" },
	};
	const firstSuccess = {
		type: "tool_execution_end",
		toolCallId: "write-1",
		toolName: "write",
		isError: false,
		result: { content: [{ type: "text", text: "write complete" }] },
	};
	const repeatStart = {
		type: "tool_execution_start",
		toolCallId: "write-2",
		toolName: "write",
		args: { action: "write", path: "same.txt", contentRef: "file-content:bytes" },
	};
	const guardedRepeat = {
		type: "tool_execution_end",
		toolCallId: "write-2",
		toolName: "write",
		isError: true,
		result: {
			details: {
				piToolFailureDirective: { failureCode: "repeated_successful_call" },
				piRepeatedSuccessfulCall: { previousToolCallId: "write-1" },
			},
		},
	};
	const recovered = {
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] },
	};

	assert.equal(
		failedToolResult([firstStart, firstSuccess, repeatStart, guardedRepeat, recovered], "write"),
		undefined,
	);
	const unlinked = {
		...guardedRepeat,
		result: { details: { piToolFailureDirective: { failureCode: "repeated_successful_call" } } },
	};
	assert.equal(failedToolResult([firstStart, firstSuccess, repeatStart, unlinked, recovered], "write"), unlinked);
});

test("live workflow requires a visible assistant answer that uses a successful tool result", () => {
	const success = {
		type: "tool_execution_end",
		toolCallId: "read-1",
		toolName: "read",
		isError: false,
		result: { content: [{ type: "text", text: "phone-read-marker" }] },
	};
	const answer = {
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "phone-read-marker" }],
		},
	};
	const hiddenThinking = {
		...answer,
		message: { ...answer.message, content: [{ type: "thinking", thinking: "phone-read-marker" }] },
	};

	assert.equal(assistantReportedToolMarker([success, answer], "read", "phone-read-marker"), true);
	assert.equal(assistantReportedToolMarker([answer, success], "read", "phone-read-marker"), false);
	assert.equal(assistantReportedToolMarker([success, hiddenThinking], "read", "phone-read-marker"), false);
});

test("live acceptance scripts delegate RPC framing instead of accumulating prefixes", async () => {
	const [owner, coldStart, textProtocol] = await Promise.all([
		readFile(new URL("./lib/live-acceptance-rpc.mjs", import.meta.url), "utf8"),
		readFile(new URL("./accept-local-cold-start-live.mjs", import.meta.url), "utf8"),
		readFile(new URL("./accept-text-protocol-live.mjs", import.meta.url), "utf8"),
	]);
	assert.match(owner, /fragments\.join\(""\)/);
	assert.doesNotMatch(owner, /(?:buffer|pending|line|text)\s*\+=\s*chunk/);
	for (const source of [coldStart, textProtocol]) {
		assert.match(source, /startPiAcceptanceRpc/);
		assert.doesNotMatch(source, /function makeLineReader|function waitForEvent|function readJsonIfExists/);
	}
	assert.match(textProtocol, /waitForEvent\(\s*\(event\) => event\.type === "agent_end"/);
	assert.doesNotMatch(textProtocol, /message\.stopReason !== "toolUse"/);
});

test("live Ollama acceptance always owns an isolated low-impact runtime", async () => {
	const [owner, coldStart, textProtocol] = await Promise.all([
		readFile(new URL("./lib/ollama-acceptance-runtime.mjs", import.meta.url), "utf8"),
		readFile(new URL("./accept-local-cold-start-live.mjs", import.meta.url), "utf8"),
		readFile(new URL("./accept-text-protocol-live.mjs", import.meta.url), "utf8"),
	]);
	assert.match(owner, /profileMode:\s*"low-impact"/);
	assert.match(owner, /startWithModelsStore/);
	for (const source of [coldStart, textProtocol]) {
		assert.match(source, /startLowImpactAcceptanceOllama/);
		assert.doesNotMatch(source, /OLLAMA_KEEP_ALIVE:\s*"30m"/);
		assert.doesNotMatch(source, /OLLAMA_MAX_LOADED_MODELS:\s*"3"/);
	}
});
