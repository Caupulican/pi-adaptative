import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_LINE_CHARACTERS = 32 * 1024 * 1024;

function createBoundedLineDecoder(onLine, maxLineCharacters) {
	if (!Number.isSafeInteger(maxLineCharacters) || maxLineCharacters <= 0) {
		throw new Error(`maxLineCharacters must be a positive safe integer, got ${maxLineCharacters}`);
	}
	let fragments = [];
	let fragmentCharacters = 0;

	function ensureCapacity(additionalCharacters) {
		if (fragmentCharacters + additionalCharacters <= maxLineCharacters) return;
		throw new Error(`Pi RPC output line exceeded ${maxLineCharacters} characters`);
	}

	function append(fragment) {
		if (!fragment) return;
		ensureCapacity(fragment.length);
		fragments.push(fragment);
		fragmentCharacters += fragment.length;
	}

	function emit(finalFragment) {
		ensureCapacity(finalFragment.length);
		let line;
		if (fragments.length === 0) {
			line = finalFragment;
		} else {
			fragments.push(finalFragment);
			line = fragments.join("");
		}
		fragments = [];
		fragmentCharacters = 0;
		if (line) onLine(line);
	}

	return (chunk) => {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf("\n", start);
			if (newline === -1) {
				append(chunk.slice(start));
				return;
			}
			emit(chunk.slice(start, newline));
			start = newline + 1;
		}
	};
}

function parseJsonLine(line) {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
}

export async function readJsonIfExists(filePath) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
		throw error;
	}
}

export function handleAcceptanceHelpFlag(arg, usage, exit = process.exit) {
	if (arg !== "--help" && arg !== "-h") return false;
	usage();
	exit(0);
	return true;
}

export function startPiAcceptanceRpc({
	root,
	provider,
	model,
	agentDir,
	sessionDir,
	timeoutMs,
	maxLineCharacters = DEFAULT_MAX_LINE_CHARACTERS,
	spawnProcess = spawn,
	stderr = process.stderr,
}) {
	const events = [];
	const waits = new Set();
	let failure;
	let closing = false;
	const child = spawnProcess(
		path.join(root, "pi-test.sh"),
		[
			"--mode",
			"rpc",
			"--provider",
			provider,
			"--model",
			model,
			"--session-dir",
			sessionDir,
			"--system-prompt",
			"",
			"--no-extensions",
		],
		{
			cwd: root,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CODING_AGENT_SESSION_DIR: sessionDir,
				PI_ADAPTATIVE_CODING_AGENT_DIR: agentDir,
				PI_ADAPTATIVE_CODING_AGENT_SESSION_DIR: sessionDir,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);

	function removeWait(wait) {
		clearTimeout(wait.timer);
		waits.delete(wait);
	}

	function fail(value) {
		if (failure) return;
		failure = value instanceof Error ? value : new Error(String(value));
		for (const wait of [...waits]) {
			removeWait(wait);
			wait.reject(failure);
		}
	}

	function publish(event) {
		events.push(event);
		for (const wait of [...waits]) {
			let matches;
			try {
				matches = wait.predicate(event);
			} catch (error) {
				removeWait(wait);
				wait.reject(error);
				continue;
			}
			if (!matches) continue;
			removeWait(wait);
			wait.resolve(event);
		}
	}

	const decode = createBoundedLineDecoder((line) => {
		const event = parseJsonLine(line);
		if (event) publish(event);
	}, maxLineCharacters);
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		try {
			decode(chunk);
		} catch (error) {
			child.stdout.pause();
			fail(error);
		}
	});
	child.stdout.on("error", fail);
	child.stderr.on("data", (chunk) => stderr.write(chunk));
	child.once("error", fail);
	child.once("exit", (code, signal) => {
		if (closing) return;
		fail(new Error(`Pi RPC exited before acceptance completed (code ${code ?? "-"}, signal ${signal ?? "-"})`));
	});

	function waitForEvent(predicate, description, requestedTimeoutMs = timeoutMs, startIndex = 0) {
		for (let index = startIndex; index < events.length; index++) {
			try {
				if (predicate(events[index])) return Promise.resolve(events[index]);
			} catch (error) {
				return Promise.reject(error);
			}
		}
		if (failure) return Promise.reject(failure);
		return new Promise((resolve, reject) => {
			const wait = { predicate, resolve, reject, timer: undefined };
			wait.timer = setTimeout(() => {
				removeWait(wait);
				reject(new Error(`Timed out waiting for ${description}`));
			}, requestedTimeoutMs);
			waits.add(wait);
		});
	}

	return {
		events,
		checkpoint: () => events.length,
		send: (value) => child.stdin.write(`${JSON.stringify(value)}\n`),
		waitForEvent,
		close: () => {
			if (closing) return;
			closing = true;
			child.stdin.end();
			child.kill("SIGTERM");
		},
	};
}
