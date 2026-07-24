import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = resolve(repositoryRoot, "node_modules/vitest/dist/cli.js");

const campaigns = [
	{
		name: "crash/restart",
		packagePath: "packages/coding-agent",
		files: [
			"test/agent-session-worker-delegation.test.ts",
			"test/delegation-orchestration-ledger.test.ts",
			"test/durable-task-runtime.test.ts",
			"test/worker-lifecycle.test.ts",
		],
	},
	{
		name: "multi-session concurrency",
		packagePath: "packages/coding-agent",
		files: [
			"test/atomic-file.test.ts",
			"test/model-adaptation-store.test.ts",
			"test/orchestration-event-store.test.ts",
			"test/tool-recovery-logger.test.ts",
		],
	},
	{
		name: "concurrent transcript persistence",
		packagePath: "packages/agent",
		files: ["test/session/concurrent-file.test.ts"],
	},
	{
		name: "long-context compaction/resume soak",
		packagePath: "packages/agent",
		files: ["test/session/compacted-payload-release.test.ts"],
	},
	{
		name: "durable state across compaction",
		packagePath: "packages/coding-agent",
		files: ["test/goal-task-compaction-survival.test.ts"],
	},
	{
		name: "provider contract matrix",
		packagePath: "packages/coding-agent",
		files: [
			"test/model-contract-matrix.test.ts",
			"test/model-tool-protocol.test.ts",
			"test/worker-runner.test.ts",
			"test/agent-session-retry.test.ts",
		],
	},
	{
		name: "adversarial UAC",
		packagePath: "packages/coding-agent",
		files: [
			"test/extensions-lazy-loading.test.ts",
			"test/profile-strict-uac.test.ts",
			"test/profile-io-gating.test.ts",
			"test/runtime-builder-worker-ceiling.test.ts",
			"test/extension-live-load-unload.test.ts",
		],
	},
];

for (const campaign of campaigns) {
	process.stdout.write(`\n[core acceptance] ${campaign.name}\n`);
	const result = spawnSync(process.execPath, [vitestCli, "--run", ...campaign.files], {
		cwd: resolve(repositoryRoot, campaign.packagePath),
		stdio: "inherit",
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write("\n[core acceptance] all five reliability campaigns passed\n");
