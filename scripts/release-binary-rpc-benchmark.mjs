#!/usr/bin/env node

import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireFlagValue } from "./flag-value-args.mjs";

const DEFAULT_SAMPLES = 3;
const DEFAULT_WARM_ITERATIONS = 5;
const DEFAULT_WARMUP_SAMPLES = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CAPTURED_STDERR_BYTES = 64 * 1024;
const RPC_ARGS = ["--mode", "rpc", "--no-session", "--no-extensions"];

function positiveInteger(value, label, { allowZero = false } = {}) {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
		throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
	}
	return parsed;
}

function roundMilliseconds(value) {
	return Math.round(value * 1000) / 1000;
}

export function summarizeLatencySamples(samples) {
	if (!Array.isArray(samples) || samples.length === 0) throw new Error("At least one latency sample is required");
	const sorted = [...samples].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	const median =
		sorted.length % 2 === 0 ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2 : (sorted[middle] ?? 0);
	const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
	return {
		samples: samples.map(roundMilliseconds),
		minMs: roundMilliseconds(sorted[0] ?? 0),
		medianMs: roundMilliseconds(median),
		p95Ms: roundMilliseconds(sorted[p95Index] ?? 0),
		maxMs: roundMilliseconds(sorted.at(-1) ?? 0),
	};
}

function responseError(response, expectedId, expectedCommand) {
	if (response?.type !== "response" || response.id !== expectedId || response.command !== expectedCommand) {
		return `Invalid ${expectedCommand} RPC response: ${JSON.stringify(response)}`;
	}
	if (response.success !== true) {
		return typeof response.error === "string" ? response.error : `${expectedCommand} RPC request failed`;
	}
	return undefined;
}

function createRpcClient({ executable, executableArgs, requestTimeoutMs, env }) {
	const child = spawn(executable, [...executableArgs, ...RPC_ARGS], {
		env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	let stdoutBuffer = "";
	let stderr = "";
	let terminal;
	let resolveTerminal;
	const terminalPromise = new Promise((resolveTerminalPromise) => {
		resolveTerminal = resolveTerminalPromise;
	});
	const pending = new Map();

	const capturedStderr = () => (stderr.trim() ? `: ${stderr.trim()}` : "");
	const settleTerminal = (outcome) => {
		if (terminal) return;
		terminal = outcome;
		resolveTerminal(outcome);
		const message =
			outcome.kind === "error"
				? `Benchmark process failed before RPC response: ${outcome.error.message}${capturedStderr()}`
				: `Benchmark process closed before RPC response (code ${outcome.code ?? "null"}, signal ${outcome.signal ?? "none"})${capturedStderr()}`;
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(new Error(message));
		}
		pending.clear();
	};

	const consumeLine = (line) => {
		if (line.trim() === "") return;
		let response;
		try {
			response = JSON.parse(line);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error(`Benchmark process emitted invalid JSONL: ${message}`));
			}
			pending.clear();
			child.kill();
			return;
		}
		if (response?.type !== "response" || typeof response.id !== "string") return;
		const request = pending.get(response.id);
		if (!request) return;
		pending.delete(response.id);
		clearTimeout(request.timer);
		request.resolve(response);
	};

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer += chunk;
		let newline = stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			consumeLine(stdoutBuffer.slice(0, newline));
			stdoutBuffer = stdoutBuffer.slice(newline + 1);
			newline = stdoutBuffer.indexOf("\n");
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr = (stderr + chunk).slice(-MAX_CAPTURED_STDERR_BYTES);
	});
	child.on("error", (error) => settleTerminal({ kind: "error", error }));
	child.on("exit", (code, signal) => settleTerminal({ kind: "exit", code, signal }));

	const request = (payload) => {
		if (terminal) {
			return Promise.reject(new Error(`Benchmark process is not running${capturedStderr()}`));
		}
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				pending.delete(payload.id);
				child.kill();
				rejectRequest(new Error(`Timed out after ${requestTimeoutMs}ms waiting for RPC response ${payload.id}`));
			}, requestTimeoutMs);
			pending.set(payload.id, { resolve: resolveRequest, reject: rejectRequest, timer });
			child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
				if (!error) return;
				const active = pending.get(payload.id);
				if (!active) return;
				pending.delete(payload.id);
				clearTimeout(active.timer);
				active.reject(new Error(`Failed to write RPC request ${payload.id}: ${error.message}`));
			});
		});
	};

	const close = async () => {
		if (!terminal) child.stdin.end();
		const timeout = new Promise((_, rejectTimeout) => {
			const timer = setTimeout(() => {
				child.kill();
				rejectTimeout(new Error(`Benchmark process did not exit within ${requestTimeoutMs}ms after stdin closed`));
			}, requestTimeoutMs);
			terminalPromise.finally(() => clearTimeout(timer));
		});
		const outcome = await Promise.race([terminalPromise, timeout]);
		if (outcome.kind === "error") throw outcome.error;
		if (outcome.code !== 0) {
			throw new Error(
				`Benchmark process exited with code ${outcome.code ?? "null"}, signal ${outcome.signal ?? "none"}${capturedStderr()}`,
			);
		}
	};

	return {
		request,
		close,
		abort: () => {
			if (!terminal) child.kill();
		},
	};
}

async function runSample(options, sampleIndex) {
	const processStartedAt = performance.now();
	const client = createRpcClient(options);
	const markerPrefix = `pi-binary-benchmark-${sampleIndex}`;
	try {
		const stateId = `${markerPrefix}-cold-state`;
		const state = await client.request({ id: stateId, type: "get_state" });
		const coldRpcMs = performance.now() - processStartedAt;
		const stateFailure = responseError(state, stateId, "get_state");
		if (stateFailure) throw new Error(stateFailure);

		const coldShellId = `${markerPrefix}-cold-shell`;
		const coldShellStartedAt = performance.now();
		const coldShell = await client.request({ id: coldShellId, type: "bash", command: "echo benchmark-ok" });
		const coldShellMs = performance.now() - coldShellStartedAt;
		const firstShellReadyMs = performance.now() - processStartedAt;
		const coldShellFailure = responseError(coldShell, coldShellId, "bash");
		if (coldShellFailure) throw new Error(coldShellFailure);
		if (coldShell.data?.exitCode !== 0 || !String(coldShell.data?.output ?? "").includes("benchmark-ok")) {
			throw new Error(`Cold shell RPC contract failed: ${JSON.stringify(coldShell)}`);
		}

		const warmRpcMs = [];
		const warmShellMs = [];
		for (let iteration = 0; iteration < options.warmIterations; iteration += 1) {
			const warmStateId = `${markerPrefix}-warm-state-${iteration}`;
			const warmStateStartedAt = performance.now();
			const warmState = await client.request({ id: warmStateId, type: "get_state" });
			warmRpcMs.push(performance.now() - warmStateStartedAt);
			const warmStateFailure = responseError(warmState, warmStateId, "get_state");
			if (warmStateFailure) throw new Error(warmStateFailure);

			const warmShellId = `${markerPrefix}-warm-shell-${iteration}`;
			const warmShellStartedAt = performance.now();
			const warmShell = await client.request({ id: warmShellId, type: "bash", command: "echo benchmark-ok" });
			warmShellMs.push(performance.now() - warmShellStartedAt);
			const warmShellFailure = responseError(warmShell, warmShellId, "bash");
			if (warmShellFailure) throw new Error(warmShellFailure);
			if (warmShell.data?.exitCode !== 0 || !String(warmShell.data?.output ?? "").includes("benchmark-ok")) {
				throw new Error(`Warm shell RPC contract failed: ${JSON.stringify(warmShell)}`);
			}
		}

		await client.close();
		return { coldRpcMs, coldShellMs, firstShellReadyMs, warmRpcMs, warmShellMs };
	} catch (error) {
		client.abort();
		throw error;
	}
}

export async function runReleaseBinaryRpcBenchmark({
	executable,
	executableArgs = [],
	samples = DEFAULT_SAMPLES,
	warmIterations = DEFAULT_WARM_ITERATIONS,
	warmupSamples = DEFAULT_WARMUP_SAMPLES,
	requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	env = process.env,
	label = `${process.platform}-${process.arch}`,
}) {
	if (typeof executable !== "string" || executable.length === 0) throw new Error("A benchmark executable is required");
	positiveInteger(String(samples), "samples");
	positiveInteger(String(warmIterations), "warmIterations");
	positiveInteger(String(warmupSamples), "warmupSamples", { allowZero: true });
	positiveInteger(String(requestTimeoutMs), "requestTimeoutMs");

	for (let index = 0; index < warmupSamples; index += 1) {
		await runSample({ executable, executableArgs, warmIterations, requestTimeoutMs, env }, `warmup-${index}`);
	}

	const measured = [];
	for (let index = 0; index < samples; index += 1) {
		measured.push(await runSample({ executable, executableArgs, warmIterations, requestTimeoutMs, env }, index));
	}

	return {
		schemaVersion: 2,
		label,
		platform: process.platform,
		architecture: process.arch,
		samples,
		warmIterations,
		metrics: {
			coldRpc: summarizeLatencySamples(measured.map((sample) => sample.coldRpcMs)),
			coldShell: summarizeLatencySamples(measured.map((sample) => sample.coldShellMs)),
			firstShellReady: summarizeLatencySamples(measured.map((sample) => sample.firstShellReadyMs)),
			warmRpc: summarizeLatencySamples(measured.flatMap((sample) => sample.warmRpcMs)),
			warmShell: summarizeLatencySamples(measured.flatMap((sample) => sample.warmShellMs)),
		},
	};
}

function parseCliArgs(argv) {
	const options = {
		samples: DEFAULT_SAMPLES,
		warmIterations: DEFAULT_WARM_ITERATIONS,
		warmupSamples: DEFAULT_WARMUP_SAMPLES,
		requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		const value = requireFlagValue(argv, index);
		switch (argument) {
			case "--binary":
				options.executable = resolve(value);
				break;
			case "--samples":
				options.samples = positiveInteger(value, "--samples");
				break;
			case "--warm-iterations":
				options.warmIterations = positiveInteger(value, "--warm-iterations");
				break;
			case "--warmup-samples":
				options.warmupSamples = positiveInteger(value, "--warmup-samples", { allowZero: true });
				break;
			case "--request-timeout-ms":
				options.requestTimeoutMs = positiveInteger(value, "--request-timeout-ms");
				break;
			case "--label":
				options.label = value;
				break;
			case "--output":
				options.output = resolve(value);
				break;
			default:
				throw new Error(`Unknown argument: ${argument}`);
		}
		index += 1;
	}
	if (!options.executable) throw new Error("--binary is required");
	return options;
}

async function main() {
	const options = parseCliArgs(process.argv.slice(2));
	const result = await runReleaseBinaryRpcBenchmark(options);
	const serialized = `${JSON.stringify(result, null, 2)}\n`;
	if (options.output) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, serialized);
	}
	process.stdout.write(`PI_RELEASE_BINARY_BENCHMARK=${JSON.stringify(result)}\n`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
