import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "node:test";

import { readJsonIfExists, startPiAcceptanceRpc } from "./lib/live-acceptance-rpc.mjs";

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
});
