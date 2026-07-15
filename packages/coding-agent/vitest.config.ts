import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const codingAgentSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const agentSrcNode = fileURLToPath(new URL("../agent/src/node.ts", import.meta.url));
const agentSrcPaths = fileURLToPath(new URL("../agent/src/utils/paths.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		// Many files spawn additional Node processes. Unbounded CPU-based parallelism exhausts
		// memory on development and CI hosts, making unrelated 30s tests fail nondeterministically.
		maxWorkers: 4,
		// Scratch/live-model tests (test/scratch-*.test.ts) are OPT-IN. They gate on a reachable
		// local Ollama and, when it is reachable, run real model generations that time out under CI
		// or parallel load — so a plain `vitest --run` was non-deterministic (runs flipped between
		// green and timeout-failures purely on machine load, which repeatedly muddied verification).
		// Excluded by default so the suite is deterministic and needs no manual --exclude; set
		// PI_RUN_SCRATCH=1 to run them deliberately.
		exclude: [
			...configDefaults.exclude,
			...(process.env.PI_RUN_SCRATCH === "1" ? [] : ["**/scratch-*.test.ts"]),
		],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@caupulican\/pi-adaptative$/, replacement: codingAgentSrcIndex },
			{ find: /^@earendil-works\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@mariozechner\/pi-coding-agent$/, replacement: codingAgentSrcIndex },
			{ find: /^@caupulican\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@caupulican\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@caupulican\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@caupulican\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@caupulican\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@earendil-works\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@earendil-works\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@mariozechner\/pi-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/pi-agent-core$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/pi-agent-core\/node$/, replacement: agentSrcNode },
			{ find: /^@mariozechner\/pi-agent-core\/paths$/, replacement: agentSrcPaths },
			{ find: /^@caupulican\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@earendil-works\/pi-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/pi-tui$/, replacement: tuiSrcIndex },
		],
	},
});
