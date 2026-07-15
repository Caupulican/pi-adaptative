#!/usr/bin/env node

if (process.env.PI_OFFLINE === "1" || process.env.PI_OFFLINE?.toLowerCase() === "true") {
	console.log("pi: offline mode enabled; skipped uv/Python provisioning");
	process.exit(0);
}

try {
	const { ensurePythonRuntime } = await import("../dist/core/python-runtime.js");
	const outcome = await ensurePythonRuntime({ force: true, silent: false });
	if (outcome.status === "ready") {
		console.log(`pi: Python ready via uv (${outcome.pythonPath})`);
	} else {
		console.warn(`pi: Python provisioning deferred: ${outcome.reason}`);
	}
} catch (error) {
	// Package installation must remain usable offline and on unsupported hosts.
	// Doctor and first tool use retry through the same bounded runtime manager.
	console.warn(`pi: Python provisioning deferred: ${error instanceof Error ? error.message : String(error)}`);
}
