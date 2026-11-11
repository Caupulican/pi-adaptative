/**
 * Regression and determinism tests for the bundled `explain-flow` visual-workflow engine (`flow-film.mjs`),
 * verifying byte-identical backward compatibility on existing specs, stateful workflow primitives (`vars`,
 * `card`, `batch`, `slots`, `note.cues`, `run.rounds`), inlined HTML script execution, layout validation,
 * and concurrent branch scheduling in diagram/plan imports.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { batchHitSchedule } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/batch.mjs";
import { drawLive, frameSvg } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/draw.mjs";
import { specFromGraph } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/graph-layout.mjs";
import { readDiagram } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/read-diagram.mjs";
import {
	buildScene,
	SpecError,
	storyboard,
} from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/scene.mjs";
import { stateAt } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/state.mjs";
import { themeFromHarness } from "../packages/coding-agent/src/bundled-resources/skills/explain-flow/scripts/lib/theme.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const EXPLAIN_FLOW_DIR = join(ROOT, "packages/coding-agent/src/bundled-resources/skills/explain-flow");
const FLOW_FILM_CLI = join(EXPLAIN_FLOW_DIR, "scripts/flow-film.mjs");
const ASSETS_DIR = join(EXPLAIN_FLOW_DIR, "assets");

const SAMPLE_TIMESTAMPS = [0, 0.5, 1.2, 3.5, 6.4, 8.1, 11.3, 15.2, 22.7, 37.9];

const PLAN_FLOW_HASHES = {
	0: "150b068c7da20229d16c2df09563b2e09ee24b25dba5e83d7d59748700d85b67",
	0.5: "654aad8c3385736637d5579a5b67bf651565301a330aacefddfd476796938fb3",
	1.2: "5ed8d7096b4e8640f7bb92adc30c4a4ab1b451fbe5a926179d3c0ed5b99843b6",
	3.5: "c863790dab447bf83e4c78e5394ad58cf310588b11e3ba0d607eafaa9a654982",
	6.4: "e89e83c776c7ea70685fc4aaa94968e37aa5e5165f4209958424db8611723e43",
	8.1: "1c897114e79862e2495078fc9ac7a07d8c7c9e1c7f38ca4bd1304fab64a73ba3",
	11.3: "013ec196751678e45fc20623f84a3c17304110ec03a0f9592b44c5eadcb7e24a",
	15.2: "eb610e542531feba873fbedcae1023fcb00645f498b70212bf12eabf86aff22a",
	22.7: "c39ff7e8109b74e06ca6c6c25bb9b819e72c5974d3e77aebbcdd91d44a4d0064",
	37.9: "3558556381b962d6dd58873d468aa42c0df4450f25e29e6081661d407fde70c2",
	storyboard: "7d4ea35a6c5dcc7c8f37e3112c46431ab2243a454ac04e87441520dd60e5bcc7",
};

const ROUND_LOOP_HASHES = {
	0: "1c2015b4c1d60a37a4c872d46133dff95d9ba82d258a3dd4d7f1a40755096d96",
	0.5: "e7c72cfb75a5148a77caf452dd10a58ce5af350fa74670b64c37b579a5ef24a2",
	1.2: "4074d84178a08aa45dcf12a396302401a5b3f2355e66b16d3a80930356925795",
	3.5: "bb75114c6dfd291d1e3b5e7b70be150752b3f583a6d1be926e6b48d0ab4ddbdc",
	6.4: "a165e884a73dbd5b06b55e96f95582519ae07aa1b20ad729c8c1dbbda4e08054",
	8.1: "2fdb754fca99eab55713e8ef5bd7f9078f3c7b74a496d39e550b551e9f98c702",
	11.3: "8794db3fe2c5a5f1fd9977e918e98e88b680bc97bb6251930825269314ee63e1",
	15.2: "798ed5b6e3aa5d55768b0b9d831ebf8ded933c9a8d67e36b3039d109e494379f",
	22.7: "d926d744ad13c9ba09727d32d0db8ea929b134a088505325ede675644d03d616",
	37.9: "6d345b9721ee44d8d255ac187cbd9914e7903828ffb6852885a1e2b4e9d65328",
	storyboard: "9dfe0574e2182f639da2bb5dc9c89c3039a971a83a6a2ea84a87c33f686b9e40",
};

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

function loadAsset(name) {
	return JSON.parse(readFileSync(join(ASSETS_DIR, name), "utf8"));
}

test("existing plan-flow.json and round-loop.json render byte-for-byte identically to baseline", () => {
	for (const [assetName, expected] of [
		["plan-flow.json", PLAN_FLOW_HASHES],
		["round-loop.json", ROUND_LOOP_HASHES],
	]) {
		const scene = buildScene(loadAsset(assetName));
		assert.equal(sha256(storyboard(scene).join("\n")), expected.storyboard, `${assetName} storyboard digest`);
		for (const timestamp of SAMPLE_TIMESTAMPS) {
			assert.equal(
				sha256(frameSvg(scene, timestamp)),
				expected[timestamp],
				`${assetName} frameSvg(${timestamp}) digest`,
			);
		}
	}
});

test("stateful-workflow.json compiles cleanly and replays statelessly across rounds and themes", () => {
	const rawSpec = loadAsset("stateful-workflow.json");
	const matrixScene = buildScene(rawSpec);
	const paperScene = buildScene({ ...rawSpec, theme: "paper" });
	const harnessProblems = [];
	const harnessTheme = themeFromHarness(
		{
			export: { pageBg: "#101418" },
			colors: {
				borderMuted: "#2a343d",
				text: "#e6edf3",
				dim: "#7d8590",
				warning: "#d29922",
				success: "#3fb950",
				error: "#f85149",
				mdLink: "#58a6ff",
			},
		},
		harnessProblems,
	);
	assert.deepEqual(harnessProblems, []);
	const harnessScene = buildScene({ ...rawSpec, theme: harnessTheme });

	assert.equal(matrixScene.width, 1360);
	assert.equal(matrixScene.height, 920);
	assert.equal(matrixScene.rounds, 3);
	assert.equal(matrixScene.loop, 8);
	const leftEdges = new Set(matrixScene.nodes.map((node) => Math.round(node.shape.box.x)));
	assert.equal(leftEdges.size, 4);

	// Stateless replay: forward and reverse evaluation yield identical frames.
	const checkpoints = [0.2, 2.9, 3.0, 4.5, 8.2, 11.0, 12.5, 13.8, 16.4, 19.0, 21.5];
	const forward = checkpoints.map((time) => frameSvg(matrixScene, time));
	const reversed = [...checkpoints]
		.reverse()
		.map((time) => frameSvg(matrixScene, time))
		.reverse();
	assert.deepEqual(forward, reversed);
	for (const time of [0.2, 11.0, 21.5]) {
		assert.ok(frameSvg(paperScene, time).includes("#f4f1e8"));
		assert.ok(frameSvg(harnessScene, time).includes("#101418"));
	}

	// Per-round vars substitution across rounds 1, 2 and 3.
	assert.ok(frameSvg(matrixScene, 1.0).includes("&gt; check: auth"));
	assert.ok(frameSvg(matrixScene, 9.0).includes("&gt; check: auth.token"));
	assert.ok(frameSvg(matrixScene, 17.0).includes("&gt; check: auth.token.ttl"));

	// Round 2 narrowed batch: 3 active items, bead mid-flight at 11.0s, 2 collected matches by 12.0s.
	const midBead = stateAt(matrixScene, 11.0);
	assert.equal(midBead.round, 1);
	assert.equal(midBead.batches.get("cold-suites").tiles.length, 8);
	assert.equal(midBead.batches.get("warm-suites").tiles.length, 3);
	assert.equal(midBead.beads.length, 1);
	assert.ok(midBead.beads[0].trail !== undefined);

	const warmNode = matrixScene.nodes.find((node) => node.id === "warm-suites");
	const round2Hits = batchHitSchedule(matrixScene, warmNode, 1).hits;
	assert.deepEqual(
		round2Hits.map((hit) => hit.output),
		["05 token.spec:42", "07 ttl.spec:11"],
	);
	assert.ok(frameSvg(matrixScene, 12.0).includes(">05</tspan>"));
	assert.ok(frameSvg(matrixScene, 12.0).includes(" token.spec:42</tspan>"));
	assert.ok(frameSvg(matrixScene, 12.0).includes(" ttl.spec:11</tspan>"));
	assert.ok(frameSvg(matrixScene, 9.0).includes("warm reads prev and skips 5 suites"));
	assert.ok(frameSvg(matrixScene, 12.5).includes("warm finishes early and swaps A into prev"));

	// Slots state: mid-swap interpolation at 12.5s (round 2 @ 4.5s) and swapped cells after 13.5s, then round 3 heap=3 and warm prev=B.
	const midSwap = stateAt(matrixScene, 12.5).slots.get("warm-slots");
	assert.ok(midSwap.swap !== undefined);
	assert.deepEqual([midSwap.swap.a, midSwap.swap.b], [0, 1]);
	assert.ok(midSwap.swap.part > 0 && midSwap.swap.part < 1);

	const postR2Swap = stateAt(matrixScene, 13.6).slots.get("warm-slots");
	assert.equal(postR2Swap.swap, undefined);
	assert.equal(postR2Swap.cards[0].tag, "A");
	assert.equal(postR2Swap.cards[0].text, "2 suites");
	assert.equal(postR2Swap.cards[1].tag, "B");
	assert.equal(postR2Swap.cards[1].tone, "dim");

	const settledR3 = stateAt(matrixScene, 21.5);
	const coldHeap = settledR3.slots.get("cold-heap");
	assert.deepEqual(
		coldHeap.cards.map((card) => card?.tag),
		["1", "2", "3"],
	);
	const warmSlots = settledR3.slots.get("warm-slots");
	assert.equal(warmSlots.cards[0].tag, "B");
	assert.equal(warmSlots.cards[0].text, "1 suite");
	assert.equal(warmSlots.cards[1].tag, "A");
	assert.equal(warmSlots.cards[1].tone, "dim");
});

test("self-contained html output executes cleanly in strict mode and matches ESM drawLive", () => {
	const scratch = mkdtempSync(join(tmpdir(), "flow-film-html-test-"));
	try {
		const outPath = join(scratch, "workflow.html");
		execFileSync(process.execPath, [FLOW_FILM_CLI, "html", join(ASSETS_DIR, "stateful-workflow.json"), "--out", outPath], {
			encoding: "utf8",
		});
		const html = readFileSync(outPath, "utf8");
		const match = /<script>\n([\s\S]*?)\n<\/script>/.exec(html);
		assert.ok(match, "expected inline <script> block in HTML output");

		const liveElement = { innerHTML: "" };
		const playButton = {
			textContent: "",
			addEventListener() {},
			setAttribute() {},
		};
		const stageElement = {
			innerHTML: "",
			querySelector(selector) {
				return selector === "#live" ? liveElement : null;
			},
		};
		class FakeButton {}
		const context = {
			URLSearchParams,
			HTMLButtonElement: FakeButton,
			location: { search: "?t=11" },
			matchMedia: () => ({ matches: true }),
			document: {
				getElementById(id) {
					if (id === "stage") return stageElement;
					if (id === "play") return playButton;
					return null;
				},
				querySelectorAll() {
					return [];
				},
			},
			addEventListener() {},
			requestAnimationFrame(callback) {
				if (!context.__ran) {
					context.__ran = true;
					callback(0);
				}
			},
		};
		vm.runInNewContext(match[1], context, { filename: "workflow-inline.js" });

		const expectedScene = buildScene(loadAsset("stateful-workflow.json"));
		assert.equal(liveElement.innerHTML, drawLive(expectedScene, stateAt(expectedScene, 11)));
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
});

test("SpecError validates vars, run.rounds, per-round capacity, batch plans, slots swaps, and wire crossings", () => {
	const baseSpec = () => ({
		title: "Validation",
		size: [1100, 500],
		loop: 6,
		rounds: 2,
		vars: { filter: ["one", "two"] },
		bands: [{ id: "main", tier: "live", title: "MAIN", height: 42 }],
		nodes: [
			{ id: "src", kind: "card", band: "main", at: [6, 4], lines: ["> {filter}"], cursor: true, w: 18 },
			{
				id: "scan",
				kind: "batch",
				band: "main",
				at: [34, 4],
				items: ["a", "b", "c"],
				plan: [
					{ active: ["a", "b"], hits: ["a"] },
					{ active: ["a"], hits: ["a"] },
				],
			},
			{
				id: "buf",
				kind: "slots",
				band: "main",
				at: [60, 4],
				cells: 2,
				cellW: 14,
				initial: [{ tag: "A", text: "init", tone: "dim" }, null],
				changes: [
					{ round: 1, at: 3.0, op: "write", cell: 1, tag: "B", text: "ok", tone: "ok" },
					{ round: 2, at: 3.2, op: "swap", cells: [0, 1], duration: 0.5 },
				],
			},
		],
		wires: [
			{ from: "src", to: "scan" },
			{ from: "scan", to: "buf:1.in" },
		],
		runs: [
			{ id: "r1", from: "src", start: 0.4, rounds: [1], steps: [{ to: "scan", work: 1.2 }, { to: "buf:1.in" }] },
			{ id: "r2", from: "src", start: 0.4, rounds: [2], steps: [{ to: "scan", work: 1.2 }, { to: "buf:1.in" }] },
		],
	});

	// Disjoint run.rounds at the same start time pass cleanly.
	assert.doesNotThrow(() => buildScene(baseSpec()));

	// Overlapping stays in the SAME round fail capacity check.
	const overlap = baseSpec();
	overlap.runs[1].rounds = [1, 2];
	assert.throws(() => buildScene(overlap), (err) => err instanceof SpecError && /would hold 2 items/.test(err.message));

	// Wrong vars array length fails.
	const badVars = baseSpec();
	badVars.vars = { filter: ["only-one"] };
	assert.throws(() => buildScene(badVars), (err) => err instanceof SpecError && /vars\.filter/.test(err.message));

	// Out-of-range run.rounds fails.
	const badRounds = baseSpec();
	badRounds.runs[0].rounds = [0, 3];
	assert.throws(() => buildScene(badRounds), (err) => err instanceof SpecError && /runs\[0\]\.rounds/.test(err.message));

	// Unknown item in batch.plan fails.
	const badBatch = baseSpec();
	badBatch.nodes[1].plan[0].hits = ["z"];
	assert.throws(() => buildScene(badBatch), (err) => err instanceof SpecError && /not in active/.test(err.message));

	// Identical swap cells fail.
	const badSwap = baseSpec();
	badSwap.nodes[2].changes[1].cells = [1, 1];
	assert.throws(() => buildScene(badSwap), (err) => err instanceof SpecError && /two distinct cells/.test(err.message));

	// Wire running straight through an intermediate station fails layout check.
	const blockedWire = baseSpec();
	blockedWire.wires = [{ from: "src", to: "buf" }];
	blockedWire.runs = [{ id: "cross", from: "src", start: 0.4, steps: [{ to: "buf" }] }];
	assert.throws(
		() => buildScene(blockedWire),
		(err) => err instanceof SpecError && /runs through "scan"/.test(err.message),
	);
});

test("diagram and plan importers schedule independent branches concurrently and compile cleanly", () => {
	// Mermaid flowchart with fan-out and fan-in.
	const mermaidFlow = `flowchart LR
  Start([Trigger]) --> Cold[Cold pass]
  Start --> Warm[Warm pass]
  Cold --> Done((Record))
  Warm --> Done`;
	const flowImported = specFromGraph(readDiagram(mermaidFlow, "branch.mmd"));
	const flowScene = buildScene(flowImported.spec);
	assert.equal(flowScene.runs.length, 2);
	assert.equal(flowScene.runs[0].start, flowScene.runs[1].start);

	// Harness plan JSON with parallel steps joining at one verification step.
	const planJson = JSON.stringify({
		title: "Parallel verification",
		steps: [
			{ id: "lint", do: "Check formatting" },
			{ id: "types", do: "Check types" },
			{ id: "gate", do: "Verify bundle", uses: ["lint", "types"], join: "verify" },
		],
	});
	const planImported = specFromGraph(readDiagram(planJson, "plan.json"));
	const planScene = buildScene(planImported.spec);
	assert.equal(planScene.runs.length, 2);
	// Both branches share the final `gate` worker, so the second branch shifts just enough to clear `gate` without waiting for the entire first run to finish.
	const firstRunEnd = planScene.runs[0].start + planScene.runs[0].segments.at(-1).to;
	assert.ok(planScene.runs[1].start > planScene.runs[0].start);
	assert.ok(planScene.runs[1].start < firstRunEnd);

	// Graphviz DOT and Mermaid sequenceDiagram round-trip cleanly into valid scenes.
	const dot = `digraph G {
  entry -> parse -> check;
}`;
	assert.doesNotThrow(() => buildScene(specFromGraph(readDiagram(dot, "flow.dot")).spec));

	const sequence = `sequenceDiagram
  participant User
  participant Agent
  participant Tool
  User->>Agent: ask
  Agent->>Tool: run
  Tool-->>Agent: output`;
	assert.doesNotThrow(() => buildScene(specFromGraph(readDiagram(sequence, "seq.mmd")).spec));
});
