#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFlagValue } from "./flag-value-args.mjs";

export const RELEASE_SMOKE_PROVIDER = "release-smoke";
export const RELEASE_SMOKE_MODEL = "deterministic";
export const RELEASE_SMOKE_MODEL_NAME = "Deterministic Release Smoke";
export const RELEASE_SMOKE_REPLY = "PI_RELEASE_SMOKE_REPLY_7F3C";

const RELEASE_SMOKE_API_KEY = "release-smoke-loopback-key";
const RELEASE_SMOKE_RESOURCE_PROFILE = "release-smoke-bundled-extension";
const RELEASE_SMOKE_RESOURCE_PROFILE_JSON = JSON.stringify({
	[RELEASE_SMOKE_RESOURCE_PROFILE]: { extensions: { allow: ["tmux-agent-manager"] } },
});
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_CHARS = 1_048_576;
const MAX_REQUEST_BYTES = 1_048_576;

function printUsage() {
	console.log(`Usage: node scripts/release-artifact-smoke.mjs [options]

Runs release-shaped smoke tests against isolated Node-package and Bun-binary
artifacts. Conversations use a deterministic loopback OpenAI-compatible stream.

Options:
  --node <path>               Path to the isolated npm/Node pi executable
  --bun <path>                Path to the Bun-compiled pi executable
  --expected-version <value>  Exact release version expected from both artifacts
  --timeout-ms <value>        Per-command timeout (default: ${DEFAULT_COMMAND_TIMEOUT_MS})
  --help                      Show this help
`);
}

function parseArgs(argv) {
	const artifacts = [];
	let commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS;
	let expectedVersion;

	for (let index = 0; index < argv.length; index++) {
		const argument = argv[index];
		if (argument === "--help") {
			printUsage();
			return undefined;
		}
		if (argument === "--node" || argument === "--bun") {
			const executable = requireFlagValue(argv, index);
			artifacts.push({ label: argument === "--node" ? "Node package" : "Bun binary", executable });
			index++;
			continue;
		}
		if (argument === "--expected-version") {
			expectedVersion = requireFlagValue(argv, index);
			index++;
			continue;
		}
		if (argument === "--timeout-ms") {
			const value = Number(requireFlagValue(argv, index));
			if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
				throw new Error("--timeout-ms must be an integer between 1000 and 300000");
			}
			commandTimeoutMs = value;
			index++;
			continue;
		}
		throw new Error(`Unknown option: ${argument}`);
	}

	if (artifacts.filter((artifact) => artifact.label === "Node package").length !== 1) {
		throw new Error("Exactly one --node executable is required");
	}
	if (artifacts.filter((artifact) => artifact.label === "Bun binary").length !== 1) {
		throw new Error("Exactly one --bun executable is required");
	}
	if (!expectedVersion) {
		throw new Error("--expected-version is required");
	}

	return { artifacts, commandTimeoutMs, expectedVersion };
}

function appendBounded(current, chunk) {
	const next = current + String(chunk);
	return next.length <= MAX_CAPTURE_CHARS ? next : next.slice(-MAX_CAPTURE_CHARS);
}

function terminateProcessGroup(child, signal) {
	if (!child.pid) return;
	try {
		if (process.platform !== "win32") {
			process.kill(-child.pid, signal);
		} else {
			child.kill(signal);
		}
	} catch {
		// The process may have exited between the timeout and the signal.
	}
}

function runProcess(command, args, options) {
	return new Promise((resolvePromise, reject) => {
		let callbackError;
		let output = "";
		let settled = false;
		let timedOut = false;
		let forceKillTimer;
		const child = spawn(command, args, {
			cwd: options.cwd,
			detached: process.platform !== "win32",
			env: options.env,
			stdio: [options.pipeInput ? "pipe" : "ignore", "pipe", "pipe"],
		});

		const forceKill = () => {
			if (forceKillTimer) return;
			terminateProcessGroup(child, "SIGTERM");
			forceKillTimer = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 1_000);
			forceKillTimer.unref();
		};
		const capture = (chunk) => {
			output = appendBounded(output, chunk);
			try {
				options.onOutput?.(output, child);
			} catch (error) {
				callbackError = error;
				forceKill();
			}
		};
		child.stdout.on("data", capture);
		child.stderr.on("data", capture);
		child.once("spawn", () => {
			try {
				options.onSpawn?.(child);
			} catch (error) {
				callbackError = error;
				forceKill();
			}
		});

		const timeout = setTimeout(() => {
			timedOut = true;
			forceKill();
		}, options.timeoutMs);
		timeout.unref();

		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimer) clearTimeout(forceKillTimer);
			if (callbackError) {
				reject(callbackError);
				return;
			}
			if (timedOut) {
				reject(new Error(`${options.label} timed out after ${options.timeoutMs}ms\n${output}`));
				return;
			}
			resolvePromise({ code, output, signal });
		});
	});
}

function runCaptured(executable, args, options) {
	return runProcess(executable, args, options);
}

function quoteShellArgument(value) {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function runInteractive(executable, args, prompt, options) {
	let markerSeen = false;
	let promptSent = false;
	const command = [executable, ...args].map(quoteShellArgument).join(" ");
	const result = await runProcess(
		"script",
		["--quiet", "--flush", "--return", "--command", command, "/dev/null"],
		{
			...options,
			onOutput(output, child) {
				if (!promptSent && output.includes(RELEASE_SMOKE_MODEL_NAME)) {
					promptSent = true;
					child.stdin.write(`${prompt}\r`);
				}
				if (!markerSeen && output.includes(RELEASE_SMOKE_REPLY)) {
					markerSeen = true;
					child.stdin.write("\u0004");
				}
			},
			pipeInput: true,
		},
	);
	return { ...result, markerSeen };
}

function requestText(messages) {
	if (!Array.isArray(messages)) return "";
	return messages
		.filter((message) => message && typeof message === "object" && message.role === "user")
		.flatMap((message) => {
			if (typeof message.content === "string") return [message.content];
			if (!Array.isArray(message.content)) return [];
			return message.content
				.filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
				.map((part) => part.text);
		})
		.join("\n");
}

function readRequestBody(request) {
	return new Promise((resolvePromise, reject) => {
		let bytes = 0;
		const chunks = [];
		request.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_REQUEST_BYTES) {
				reject(new Error(`request exceeded ${MAX_REQUEST_BYTES} bytes`));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
		request.on("error", reject);
	});
}

function writeJson(response, status, value) {
	const payload = `${JSON.stringify(value)}\n`;
	response.writeHead(status, {
		"connection": "close",
		"content-length": Buffer.byteLength(payload),
		"content-type": "application/json",
	});
	response.end(payload);
}

function writeCompletion(response, stream) {
	const created = Math.floor(Date.now() / 1_000);
	if (!stream) {
		writeJson(response, 200, {
			choices: [{ finish_reason: "stop", index: 0, message: { content: RELEASE_SMOKE_REPLY, role: "assistant" } }],
			created,
			id: "chatcmpl-release-smoke",
			model: RELEASE_SMOKE_MODEL,
			object: "chat.completion",
			usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
		});
		return;
	}

	response.writeHead(200, {
		"cache-control": "no-cache",
		"connection": "close",
		"content-type": "text/event-stream",
	});
	const chunks = [
		{
			choices: [{ delta: { content: RELEASE_SMOKE_REPLY, role: "assistant" }, finish_reason: null, index: 0 }],
			created,
			id: "chatcmpl-release-smoke",
			model: RELEASE_SMOKE_MODEL,
			object: "chat.completion.chunk",
		},
		{
			choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
			created,
			id: "chatcmpl-release-smoke",
			model: RELEASE_SMOKE_MODEL,
			object: "chat.completion.chunk",
			usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
		},
	];
	for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
	response.end("data: [DONE]\n\n");
}

function startLoopbackProvider() {
	const requests = [];
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (request.method === "GET" && url.pathname === "/v1/models") {
				writeJson(response, 200, { data: [{ id: RELEASE_SMOKE_MODEL, object: "model" }], object: "list" });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/tags") {
				writeJson(response, 200, { models: [{ model: RELEASE_SMOKE_MODEL, name: RELEASE_SMOKE_MODEL }] });
				return;
			}
			if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
				writeJson(response, 404, { error: { message: `Unsupported release-smoke route: ${request.method} ${url.pathname}` } });
				return;
			}
			if (request.headers.authorization !== `Bearer ${RELEASE_SMOKE_API_KEY}`) {
				writeJson(response, 401, { error: { message: "Invalid release-smoke authorization" } });
				return;
			}

			const body = JSON.parse(await readRequestBody(request));
			if (!body || typeof body !== "object" || body.model !== RELEASE_SMOKE_MODEL) {
				writeJson(response, 400, { error: { message: "Unexpected release-smoke model" } });
				return;
			}
			requests.push({ body, prompt: requestText(body.messages) });
			writeCompletion(response, body.stream === true);
		} catch (error) {
			if (!response.headersSent) {
				writeJson(response, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
			} else {
				response.destroy(error instanceof Error ? error : undefined);
			}
		}
	});

	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Loopback release-smoke provider did not expose a TCP address"));
				return;
			}
			resolvePromise({
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				requests,
				async close() {
					server.closeIdleConnections();
					server.closeAllConnections();
					await new Promise((resolveClose, rejectClose) => {
						server.close((error) => (error ? rejectClose(error) : resolveClose()));
					});
				},
			});
		});
	});
}

function writeAgentConfiguration(agentDirectory, baseUrl) {
	mkdirSync(agentDirectory, { recursive: true });
	writeFileSync(
		join(agentDirectory, "models.json"),
		`${JSON.stringify(
			{
				providers: {
					[RELEASE_SMOKE_PROVIDER]: {
						api: "openai-completions",
						apiKey: RELEASE_SMOKE_API_KEY,
						authHeader: true,
						baseUrl,
						models: [
							{
								contextWindow: 16_384,
								cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
								id: RELEASE_SMOKE_MODEL,
								input: ["text"],
								maxTokens: 1_024,
								name: RELEASE_SMOKE_MODEL_NAME,
								reasoning: false,
							},
						],
					},
				},
			},
			undefined,
			"\t",
		)}\n`,
	);
}

function assertSuccessful(result, label) {
	if (result.code !== 0) {
		throw new Error(`${label} failed with exit code ${result.code ?? "null"} (${result.signal ?? "no signal"})\n${result.output}`);
	}
}

function assertBundledExtensionLoaded(result, label) {
	if (/Warning: Failed to load extension/u.test(result.output)) {
		throw new Error(`${label} could not load the bundled extension\n${result.output}`);
	}
}

function requestForPrompt(requests, startIndex, prompt) {
	return requests.slice(startIndex).find((request) => request.prompt.includes(prompt));
}

export async function runReleaseArtifactSmoke(options) {
	if (!Array.isArray(options.artifacts) || options.artifacts.length === 0) {
		throw new Error("At least one release artifact is required");
	}
	if (typeof options.expectedVersion !== "string" || options.expectedVersion.length === 0) {
		throw new Error("An expected release version is required");
	}
	const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	if (!Number.isSafeInteger(commandTimeoutMs) || commandTimeoutMs < 1_000 || commandTimeoutMs > 300_000) {
		throw new Error("commandTimeoutMs must be an integer between 1000 and 300000");
	}
	const log = options.log ?? (() => {});
	const tempDirectory = mkdtempSync(join(tmpdir(), "pi-release-artifact-smoke-"));
	const provider = await startLoopbackProvider();
	const artifactResults = [];

	try {
		for (const [index, artifact] of options.artifacts.entries()) {
			const executable = resolve(artifact.executable);
			if (!existsSync(executable)) throw new Error(`${artifact.label} executable does not exist: ${executable}`);
			const artifactDirectory = join(tempDirectory, `artifact-${index}`);
			const agentDirectory = join(artifactDirectory, "agent");
			const cwd = join(artifactDirectory, "cwd");
			mkdirSync(cwd, { recursive: true });
			writeAgentConfiguration(agentDirectory, provider.baseUrl);
			const env = {
				...process.env,
				CI: "1",
				COLORTERM: "truecolor",
				NO_COLOR: "1",
				PI_ADAPTATIVE_CODING_AGENT_DIR: agentDirectory,
				PI_AMBIGUOUS_WIDTH: "narrow",
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				TERM: "xterm-256color",
			};
			const commandOptions = { cwd, env, timeoutMs: commandTimeoutMs };
			const completedStages = [];

			const help = await runCaptured(executable, ["--help"], { ...commandOptions, label: `${artifact.label} --help` });
			assertSuccessful(help, `${artifact.label} --help`);
			if (!/Usage:/u.test(help.output)) throw new Error(`${artifact.label} --help did not print usage\n${help.output}`);
			completedStages.push("help");

			const version = await runCaptured(executable, ["--version"], {
				...commandOptions,
				label: `${artifact.label} --version`,
			});
			assertSuccessful(version, `${artifact.label} --version`);
			if (version.output.trim() !== options.expectedVersion) {
				throw new Error(`${artifact.label} reported version ${JSON.stringify(version.output.trim())}, expected ${options.expectedVersion}`);
			}
			completedStages.push("version");

			const models = await runCaptured(executable, ["--list-models"], {
				...commandOptions,
				label: `${artifact.label} --list-models`,
			});
			assertSuccessful(models, `${artifact.label} --list-models`);
			if (!models.output.includes(RELEASE_SMOKE_PROVIDER) || !models.output.includes(RELEASE_SMOKE_MODEL)) {
				throw new Error(`${artifact.label} --list-models omitted the deterministic model\n${models.output}`);
			}
			completedStages.push("models");

			const commonArgs = [
				"--provider",
				RELEASE_SMOKE_PROVIDER,
				"--model",
				RELEASE_SMOKE_MODEL,
				"--no-session",
				"--resource-profile-json",
				RELEASE_SMOKE_RESOURCE_PROFILE_JSON,
				"--resource-profile",
				RELEASE_SMOKE_RESOURCE_PROFILE,
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--no-tools",
				"--system-prompt",
				"Answer the user directly with no tool calls.",
			];
			const promptPrefix = `Release smoke ${index + 1} ${artifact.label}`;
			const printPrompt = `${promptPrefix} print conversation.`;
			const printRequestStart = provider.requests.length;
			const print = await runCaptured(executable, [...commonArgs, "--print", printPrompt], {
				...commandOptions,
				label: `${artifact.label} print conversation`,
			});
			assertSuccessful(print, `${artifact.label} print conversation`);
			assertBundledExtensionLoaded(print, `${artifact.label} print conversation`);
			if (!requestForPrompt(provider.requests, printRequestStart, printPrompt)) {
				throw new Error(`${artifact.label} did not send the print prompt to the loopback provider`);
			}
			if (!print.output.includes(RELEASE_SMOKE_REPLY)) {
				throw new Error(`${artifact.label} print conversation omitted the provider reply\n${print.output}`);
			}
			completedStages.push("print");

			const interactivePrompt = `${promptPrefix} interactive conversation.`;
			const interactiveRequestStart = provider.requests.length;
			const interactive = await runInteractive(executable, commonArgs, interactivePrompt, {
				...commandOptions,
				label: `${artifact.label} interactive conversation`,
			});
			assertSuccessful(interactive, `${artifact.label} interactive conversation`);
			assertBundledExtensionLoaded(interactive, `${artifact.label} interactive conversation`);
			if (!requestForPrompt(provider.requests, interactiveRequestStart, interactivePrompt)) {
				throw new Error(`${artifact.label} did not send the interactive prompt to the loopback provider`);
			}
			if (!interactive.markerSeen) {
				throw new Error(`${artifact.label} interactive conversation omitted the provider reply\n${interactive.output}`);
			}
			completedStages.push("interactive");

			artifactResults.push({ completedStages, executable, label: artifact.label });
			log(`${artifact.label}: help, version, models, print, and interactive smoke passed`);
		}

		return { artifacts: artifactResults, requests: [...provider.requests] };
	} finally {
		await provider.close();
		rmSync(tempDirectory, { force: true, recursive: true });
	}
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
	try {
		const options = parseArgs(process.argv.slice(2));
		if (options) {
			await runReleaseArtifactSmoke({ ...options, log: (message) => console.log(message) });
			console.log("Release artifact smoke passed.");
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}
