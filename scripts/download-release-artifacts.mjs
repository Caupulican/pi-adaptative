import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, createReadStream, mkdirSync, mkdtempSync, openSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const [kind, destination, ...extra] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const headSha = process.env.GITHUB_SHA;
if (extra.length || !destination || !["binaries", "benchmarks"].includes(kind)) {
	throw new Error("Usage: node scripts/download-release-artifacts.mjs <binaries|benchmarks> <destination>");
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !/^\d+$/.test(runId ?? "") || !/^[a-f0-9]{40}$/.test(headSha ?? "")) {
	throw new Error("Release artifact download requires an exact GitHub repository, workflow run and commit");
}

const specifications =
	kind === "binaries"
		? [{
			name: "release-binaries",
			files: [
				"pi-darwin-arm64.tar.gz", "pi-darwin-x64.tar.gz", "pi-linux-x64.tar.gz",
				"pi-linux-arm64.tar.gz", "pi-windows-x64.zip", "pi-windows-arm64.zip",
			],
		}]
		: ["linux-x64", "windows-x64", "windows-arm64"].map((platform) => ({
			name: `release-binary-benchmark-${platform}`,
			files: [`pi-${platform}-benchmark.json`],
		}));
const listing = execFileSync(
	"gh",
	["api", "--paginate", `repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, "--jq", ".artifacts[] | @json"],
	{ encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000 },
);
const artifacts = listing.split(/\r?\n/)
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line));
// Artifact IDs are opaque. Reruns can upload a newer same-name artifact with a lower ID.
const selected = specifications.map((specification) => {
	const candidates = artifacts.filter((artifact) => artifact?.name === specification.name);
	for (const artifact of candidates) {
		if (
			typeof artifact.expired !== "boolean" || !Number.isSafeInteger(artifact.id) || artifact.id <= 0 ||
			!Number.isFinite(Date.parse(artifact.created_at)) || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "") ||
			String(artifact.workflow_run?.id) !== runId || artifact.workflow_run?.head_sha !== headSha
		) {
			throw new Error(`Invalid identity, timestamp or digest for ${specification.name}`);
		}
	}
	candidates.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
	const latest = candidates[0];
	if (!latest) throw new Error(`Missing current-run artifact ${specification.name}`);
	if (latest.expired) throw new Error(`Latest artifact ${specification.name} has expired`);
	if (candidates[1] && Date.parse(candidates[1].created_at) === Date.parse(latest.created_at)) {
		throw new Error(`Ambiguous latest artifact ${specification.name}`);
	}
	return { ...specification, artifact: latest };
});

function writeCommandOutput(command, args, output) {
	const descriptor = openSync(output, "wx");
	try {
		const result = spawnSync(command, args, {
			stdio: ["ignore", descriptor, "pipe"], maxBuffer: 64 * 1024, timeout: 300_000,
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`${command} failed (${result.signal ?? result.status}): ${result.stderr.toString()}`);
		}
	} finally {
		closeSync(descriptor);
	}
}

const staging = mkdtempSync(join(tmpdir(), "pi-release-artifacts-"));
try {
	const outputDirectory = resolve(destination);
	mkdirSync(outputDirectory, { recursive: true });
	for (const { artifact, files } of selected) {
		console.log(`Selected ${artifact.name}: ID ${artifact.id}, created ${artifact.created_at}, ${artifact.digest}`);
		const archive = join(staging, `${artifact.id}.zip`);
		writeCommandOutput("gh", ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], archive);
		if (statSync(archive).size > 1024 * 1024 * 1024) throw new Error("Release artifact exceeds the 1 GiB limit");
		const hash = createHash("sha256");
		for await (const chunk of createReadStream(archive)) hash.update(chunk);
		if (`sha256:${hash.digest("hex")}` !== artifact.digest) throw new Error(`Digest mismatch for ${artifact.name}`);
		const extractor = process.platform === "win32" ? "tar" : "unzip";
		const listingArgs = process.platform === "win32" ? ["-tf", archive] : ["-Z1", archive];
		const entries = execFileSync(extractor, listingArgs, { encoding: "utf8", maxBuffer: 64 * 1024, timeout: 30_000 })
			.trim().split(/\r?\n/).sort();
		const expectedEntries = [...files].sort();
		if (entries.length !== expectedEntries.length || entries.some((entry, index) => entry !== expectedEntries[index])) {
			throw new Error(`Unexpected archive entries for ${artifact.name}`);
		}
		for (const file of files) {
			const extracted = join(staging, file);
			const extractionArgs = process.platform === "win32" ? ["-xOf", archive, file] : ["-p", archive, file];
			writeCommandOutput(extractor, extractionArgs, extracted);
			copyFileSync(extracted, join(outputDirectory, file));
		}
	}
} finally {
	rmSync(staging, { recursive: true, force: true });
}
