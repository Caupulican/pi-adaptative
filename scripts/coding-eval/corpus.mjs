/** Small versioned coding tasks. Expected answers and feedback stay in the driver, outside the task checkout. */
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fixtureObservation } from "../lib/fixture-module.mjs";
import { assertSlugifyEdit } from "../lib/live-native-driver.mjs";

export const corpusVersion = 1;
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const defaults = { retries: 3, delays: [1, 5], telemetry: false };
const preset = { name: "offline", retries: 0, delays: [], telemetry: false };
const schema = {
	type: "object",
	required: ["retries", "delays"],
	properties: { retries: { type: "integer", minimum: 0 }, delays: { type: "array" }, telemetry: { type: "boolean" } },
};

export const cases = [
	{
		id: "slugify",
		kind: "single-file behavior change",
		prompt:
			"Update util.ts so slugify strips punctuation, lowercases the text and converts whitespace runs to hyphens. Add a one-line JSDoc above the exported function. Change only util.ts.",
		files: {
			"util.ts":
				'export function slugify(text: string): string {\n  return text.toLowerCase().replace(/\\s+/g, "-");\n}\n',
		},
		writable: ["util.ts"],
		check(files) {
			try {
				assertSlugifyEdit(files["util.ts"]);
				return [];
			} catch {
				return [
					"The exported slugify must pass the punctuation and whitespace cases and have the requested JSDoc.",
				];
			}
		},
	},
	{
		id: "retry-migration",
		kind: "multi-file compatibility change",
		prompt:
			"Rename retries to maxRetries in defaults.json, presets/offline.json and the schema. Preserve every value, including the offline override of zero, and all other fields and validation rules. Change only these three files.",
		files: { "defaults.json": json(defaults), "presets/offline.json": json(preset), "schema.json": json(schema) },
		writable: ["defaults.json", "presets/offline.json", "schema.json"],
		check(files) {
			const expected = {
				"defaults.json": { maxRetries: 3, delays: [1, 5], telemetry: false },
				"presets/offline.json": { name: "offline", maxRetries: 0, delays: [], telemetry: false },
				"schema.json": {
					...schema,
					required: ["maxRetries", "delays"],
					properties: {
						maxRetries: schema.properties.retries,
						delays: schema.properties.delays,
						telemetry: schema.properties.telemetry,
					},
				},
			};
			return Object.entries(expected).flatMap(([path, target]) => {
				try {
					const value = JSON.parse(files[path]);
					// JSON Schema required is a set. The delay list is ordered.
					if (path === "schema.json" && Array.isArray(value.required)) {
						value.required.sort();
						target.required.sort();
					}
					if (isDeepStrictEqual(value, target)) return [];
				} catch {
					/* Malformed JSON is a task failure. */
				}
				return [`Check the maxRetries migration and preserved values in ${path}.`];
			});
		},
	},
	{
		id: "trace-override",
		kind: "read-only diagnosis",
		prompt:
			"A scheduled job configured with 0 retries is still retried. Trace the effective value from config/defaults.json through src/options.ts into src/job.ts. Return one JSON object with keys file, operator, effectiveRetries (number), and replacement, giving the faulty file and operator, the actual retry count for 0, and the operator that preserves 0 while defaulting null or undefined. Leave the files unchanged.",
		files: {
			"config/defaults.json": json({ retries: 4 }),
			"src/options.ts":
				'import defaults from "../config/defaults.json";\nexport const limit = (value?: number | null) => value || defaults.retries;\n',
			"src/job.ts":
				'import { limit } from "./options";\nexport const job = (input: { retries?: number | null }) => ({ retryCount: limit(input.retries) });\n',
		},
		writable: [],
		check(_files, answer) {
			try {
				const body = answer.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/u, "$1");
				if (
					isDeepStrictEqual(JSON.parse(body), {
						file: "src/options.ts",
						operator: "||",
						effectiveRetries: 4,
						replacement: "??",
					})
				)
					return [];
			} catch {
				/* A response in the requested schema is part of this task. */
			}
			return ["Return the requested JSON diagnosis with the faulty path, operators, and effective retry count."];
		},
	},
	{
		id: "event-adapters",
		kind: "cross-module incident repair",
		prompt:
			"Our deployment dashboard merges two event feeds and sometimes shows a successful job as failed after a replay. Repair the three exported functions in sources/build.ts, sources/deploy.ts and state/latest.ts. Both adapters must produce {id, sequence, status} without modifying their input. buildEvent reads job, attempt and ok (boolean). deployEvent reads target, revision and result (passed or failed). Normalize status to passed or failed and preserve zero sequence numbers. latest receives an array of normalized events and returns an object keyed by id with its latest status. Select the largest numeric sequence per id regardless of arrival order. The first event wins ties. Each adapter and the reducer is also used independently. Keep each module self-contained with its current public export. Change only these three files.",
		files: {
			"sources/build.ts":
				"export const buildEvent = (e: any) => ({id: e.job, sequence: e.attempt || 1, status: e.ok});\n",
			"sources/deploy.ts":
				'export const deployEvent = (e: any) => ({id: e.target, sequence: e.revision || 1, status: "passed"});\n',
			"state/latest.ts":
				"export function latest(events: any[]) { return Object.fromEntries(events.map(e => [e.id, e.status])); }\n",
			"dashboard.ts":
				'import { buildEvent } from "./sources/build";\nimport { deployEvent } from "./sources/deploy";\nimport { latest } from "./state/latest";\nexport const dashboard = (builds: any[], deploys: any[]) => latest([...builds.map(buildEvent), ...deploys.map(deployEvent)]);\n',
		},
		writable: ["sources/build.ts", "sources/deploy.ts", "state/latest.ts"],
		check(files) {
			const inputs = [
				[
					"sources/build.ts",
					"buildEvent",
					[
						{ job: "api", attempt: 10, ok: true },
						{ job: "web", attempt: 0, ok: false },
					],
				],
				[
					"sources/deploy.ts",
					"deployEvent",
					[
						{ target: "api", revision: 2, result: "failed" },
						{ target: "web", revision: 0, result: "passed" },
					],
				],
			];
			const expected = [
				[
					{ id: "api", sequence: 10, status: "passed" },
					{ id: "web", sequence: 0, status: "failed" },
				],
				[
					{ id: "api", sequence: 2, status: "failed" },
					{ id: "web", sequence: 0, status: "passed" },
				],
			];
			const observed = [];
			for (const [index, [path, fn, samples]] of inputs.entries()) {
				try {
					const { out, after } = JSON.parse(
						fixtureObservation(
							files[path],
							`(() => {
						const samples = ${JSON.stringify(samples)};
						return {out: samples.map(e => module.exports.${fn}(e)), after: samples};
					})()`,
						),
					);
					if (!isDeepStrictEqual(after, samples)) return [`Preserve adapter inputs in ${path}.`];
					if (!isDeepStrictEqual(out, expected[index]))
						return [`Check normalization and zero handling in ${path}.`];
					observed.push(...out);
				} catch {
					return [`Check the exported adapter and input immutability in ${path}.`];
				}
			}
			// Reverse the interleaving as well: a reducer that always takes the first observation fails.
			for (const events of [observed, [...observed].reverse(), []]) {
				const want = events.length ? { api: "passed", web: events[0].id === "api" ? "failed" : "passed" } : {};
				try {
					const actual = JSON.parse(
						fixtureObservation(files["state/latest.ts"], `module.exports.latest(${JSON.stringify(events)})`),
					);
					if (isDeepStrictEqual(actual, want)) continue;
				} catch {
					/* Report one stable correction for the reducer. */
				}
				return ["Check the reducer across keys, replay order, equal sequence ties, and empty input."];
			}
			return [];
		},
	},
];

// Read only regular files from the fixture. Enforce the bound on the opened descriptor too.
function readFixtureFile(path) {
	const fd = openSync(path, "r");
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 64 * 1024) return undefined;
		const bytes = Buffer.alloc(stat.size + 1);
		const count = readSync(fd, bytes, 0, bytes.length, 0);
		return count === stat.size ? bytes.subarray(0, count).toString("utf8") : undefined;
	} finally {
		closeSync(fd);
	}
}

export function grade(task, cwd, answer) {
	const contents = {};
	const allowedDirectories = new Set(
		Object.keys(task.files).flatMap((name) => {
			const parts = name.split("/");
			return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join("/"));
		}),
	);
	function visit(dir) {
		for (const entry of readdirSync(join(cwd, dir), { withFileTypes: true })) {
			if (!dir && entry.name === ".git") continue;
			const name = dir ? dir + "/" + entry.name : entry.name;
			if (entry.isDirectory() && allowedDirectories.has(name)) {
				if (!visit(name)) return false;
			} else if (entry.isFile() && Object.hasOwn(task.files, name)) {
				contents[name] = readFixtureFile(join(cwd, name));
			} else return false;
		}
		return true;
	}
	if (!lstatSync(cwd).isDirectory() || !visit(""))
		return ["Restore the requested file set; unexpected paths or links were found."];
	for (const [name, original] of Object.entries(task.files)) {
		if (typeof contents[name] !== "string") return [`Restore readable fixture file ${name}.`];
		if (!task.writable.includes(name) && contents[name] !== original)
			return [`Restore ${name}; the task requires it unchanged.`];
	}
	return task.check(contents, answer);
}
