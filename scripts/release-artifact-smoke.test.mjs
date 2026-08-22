import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	RELEASE_SMOKE_MODEL,
	RELEASE_SMOKE_MODEL_NAME,
	RELEASE_SMOKE_PROVIDER,
	RELEASE_SMOKE_REPLY,
	runReleaseArtifactSmoke,
} from "./release-artifact-smoke.mjs";

const hasScriptPty = process.platform === "linux" && spawnSync("script", ["--version"], { stdio: "ignore" }).status === 0;

function writeFixture(directory, name, source) {
	const fixturePath = join(directory, name);
	writeFileSync(fixturePath, source);
	chmodSync(fixturePath, 0o755);
	return fixturePath;
}

function responsiveCliSource(version, options = {}) {
	return `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
${
	options.extensionLoadFailure
		? 'if (args.includes("--resource-profile")) console.error("Warning: Failed to load extension bundled-fixture: missing dependency");'
		: ""
}
if (args.includes("--help")) {
	console.log("Usage: pi [options]");
	process.exit(0);
}
if (args.includes("--version")) {
	console.log(${JSON.stringify(version)});
	process.exit(0);
}
if (args.includes("--list-models")) {
	console.log(${JSON.stringify(`${RELEASE_SMOKE_PROVIDER}/${RELEASE_SMOKE_MODEL}`)});
	process.exit(0);
}

const config = JSON.parse(readFileSync(join(process.env.PI_ADAPTATIVE_CODING_AGENT_DIR, "models.json"), "utf8"));
const provider = config.providers[${JSON.stringify(RELEASE_SMOKE_PROVIDER)}];

async function requestReply(prompt) {
	const response = await fetch(provider.baseUrl + "/chat/completions", {
		method: "POST",
		headers: {
			accept: "text/event-stream",
			authorization: "Bearer " + provider.apiKey,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: ${JSON.stringify(RELEASE_SMOKE_MODEL)},
			messages: [{ role: "user", content: prompt }],
			stream: true,
		}),
	});
	if (!response.ok) throw new Error("provider returned " + response.status);
	const body = await response.text();
	let reply = "";
	for (const line of body.split("\\n")) {
		if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
		const chunk = JSON.parse(line.slice(6));
		reply += chunk.choices?.[0]?.delta?.content ?? "";
	}
	process.stdout.write(reply + "\\n");
}

if (args.includes("--print") || args.includes("-p")) {
	await requestReply(args.at(-1));
	process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.error("interactive fixture requires a TTY");
	process.exit(2);
}

process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
console.log(${JSON.stringify(RELEASE_SMOKE_MODEL_NAME)});
let pending = "";
let replied = false;
process.stdin.on("data", async (chunk) => {
	if (chunk.includes("\\u0004")) process.exit(0);
	if (chunk.includes("\\n")) {
		console.error("interactive prompt arrived before raw-mode readiness");
		process.exit(3);
	}
	pending += chunk;
	if (!replied && pending.includes("\\r")) {
		replied = true;
		await requestReply(pending.trim());
	}
});
process.stdin.on("end", () => process.exit(0));
process.stdin.resume();
`;
}

function spoofingCliSource(version) {
	return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("--help")) console.log("Usage: pi [options]");
else if (args.includes("--version")) console.log(${JSON.stringify(version)});
else if (args.includes("--list-models")) console.log(${JSON.stringify(`${RELEASE_SMOKE_PROVIDER}/${RELEASE_SMOKE_MODEL}`)});
else console.log(${JSON.stringify(RELEASE_SMOKE_REPLY)});
`;
}

test(
	"smokes Node and Bun artifacts through print and real pseudo-terminal conversations",
	{ skip: !hasScriptPty && "Linux util-linux script(1) is required" },
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-release-artifact-smoke-test-"));
		try {
			const version = "9.8.7";
			const nodeCli = writeFixture(directory, "node-pi.mjs", responsiveCliSource(version));
			const bunCli = writeFixture(directory, "bun-pi.mjs", responsiveCliSource(version));

			const result = await runReleaseArtifactSmoke({
				artifacts: [
					{ label: "Node package", executable: nodeCli },
					{ label: "Bun binary", executable: bunCli },
				],
				commandTimeoutMs: 10_000,
				expectedVersion: version,
			});

			assert.equal(result.artifacts.length, 2);
			assert.equal(result.requests.length, 4);
			for (const artifact of result.artifacts) {
				assert.deepEqual(artifact.completedStages, ["help", "version", "models", "print", "interactive"]);
			}
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test(
	"negative control rejects a CLI that prints the reply marker without reaching the provider",
	{ skip: !hasScriptPty && "Linux util-linux script(1) is required" },
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-release-artifact-smoke-negative-"));
		try {
			const version = "9.8.7";
			const spoofingCli = writeFixture(directory, "spoofing-pi.mjs", spoofingCliSource(version));
			await assert.rejects(
				runReleaseArtifactSmoke({
					artifacts: [{ label: "spoofing CLI", executable: spoofingCli }],
					commandTimeoutMs: 10_000,
					expectedVersion: version,
				}),
				/did not send the print prompt to the loopback provider/u,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);

test(
	"negative control rejects a release artifact that cannot load its bundled extension",
	{ skip: !hasScriptPty && "Linux util-linux script(1) is required" },
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-release-artifact-extension-negative-"));
		try {
			const version = "9.8.7";
			const brokenCli = writeFixture(
				directory,
				"broken-extension-pi.mjs",
				responsiveCliSource(version, { extensionLoadFailure: true }),
			);
			await assert.rejects(
				runReleaseArtifactSmoke({
					artifacts: [{ label: "broken extension CLI", executable: brokenCli }],
					commandTimeoutMs: 10_000,
					expectedVersion: version,
				}),
				/could not load the bundled extension/u,
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	},
);
