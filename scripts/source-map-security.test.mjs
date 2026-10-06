import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { generateCode, parseModule } from "magicast";
import postcss from "postcss";

const require = createRequire(import.meta.url);
const { SourceMapConsumer, SourceMapGenerator } = require("source-map-js");
const flat = { version: 3, sources: ["input.js"], names: [], mappings: "AAAA", sourcesContent: ["source text"] };

function indexed(line, column = 0, map = flat) {
	return { version: 3, sections: [{ offset: { line, column }, map }] };
}

test("indexed source maps reject invalid and excessive offsets before flattening", () => {
	for (const value of [Infinity, NaN, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
		assert.throws(() => new SourceMapConsumer(indexed(value)), /non-negative integers/);
		assert.throws(() => new SourceMapConsumer(indexed(0, value)), /non-negative integers/);
	}
	assert.throws(() => new SourceMapConsumer(indexed(10000001)), /must not exceed/);
	assert.throws(() => new SourceMapConsumer(indexed(6000000, 0, indexed(6000000))), /including offsets of nested sections/);
	// Admission boundary only: do not materialize the ten-million-line accepted boundary.
	assert.ok(new SourceMapConsumer(indexed(10000000)));
});

test("valid flat and indexed mappings preserve positions, content and generator round trips", () => {
	const consumer = new SourceMapConsumer(indexed(2, 0));
	assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 1 }), {
		source: "input.js", line: 1, column: 0, name: null,
	});
	assert.equal(consumer.sourceContentFor("input.js"), "source text");
	const output = SourceMapGenerator.fromSourceMap(consumer).toJSON();
	const roundTrip = new SourceMapConsumer(output);
	assert.deepEqual(roundTrip.originalPositionFor({ line: 3, column: 1 }), consumer.originalPositionFor({ line: 3, column: 1 }));
	assert.equal(roundTrip.sourceContentFor("input.js"), "source text");
	assert.deepEqual(new SourceMapConsumer(flat).sources, ["input.js"]);
});

test("indexed source enumeration snapshots each child getter once", () => {
	const consumer = new SourceMapConsumer(indexed(0));
	let reads = 0;
	Object.defineProperty(consumer._sections[0].consumer, "sources", { get: () => {
		reads++;
		return ["first.js", "second.js", "third.js"];
	} });
	assert.deepEqual(consumer.sources, ["first.js", "second.js", "third.js"]);
	assert.equal(reads, 1);
});

test("indexed projection retains name zero and first-line columns through nested round trips", () => {
	const named = { ...flat, names: ["first"], mappings: "AAAAA;AACA" };
	for (const map of [indexed(2, 5, named), indexed(1, 0, indexed(1, 5, named))]) {
		const consumer = new SourceMapConsumer(map);
		const expected = { source: "input.js", line: 1, column: 0, name: "first" };
		assert.deepEqual(consumer.originalPositionFor({ line: 3, column: 5 }), expected);
		assert.deepEqual(consumer.generatedPositionFor({ source: "input.js", line: 1, column: 0 }), { line: 3, column: 5 });
		assert.deepEqual(consumer.generatedPositionFor({ source: "input.js", line: 2, column: 0 }), { line: 4, column: 0 });
		assert.throws(() => consumer.generatedPositionFor({ source: "input.js", line: 0, column: 0 }), /Line must be greater than or equal to 1/);
		assert.deepEqual(consumer.generatedPositionFor({ source: "input.js", line: 3, column: 0, bias: SourceMapConsumer.LEAST_UPPER_BOUND }), { line: null, column: null });
		const roundTrip = new SourceMapConsumer(SourceMapGenerator.fromSourceMap(consumer).toJSON());
		assert.deepEqual(roundTrip.originalPositionFor({ line: 3, column: 5 }), expected);
		assert.deepEqual(roundTrip.originalPositionFor({ line: 4, column: 0 }), { source: "input.js", line: 2, column: 0, name: null });
	}
	const unmapped = new SourceMapConsumer(indexed(1, 2, { ...flat, mappings: "A" }));
	assert.equal(SourceMapGenerator.fromSourceMap(unmapped).toJSON().mappings, ";E");
	assert.deepEqual(unmapped.generatedPositionFor({ source: "input.js", line: 1, column: 0 }), { line: null, column: null });
});

test("real PostCSS and configuration consumers use the single hardened source-map owner", () => {
	const consumerRequire = createRequire(require.resolve("magicast"));
	assert.equal(realpathSync(consumerRequire.resolve("source-map-js")), realpathSync(require.resolve("source-map-js")));
	const builders = readFileSync(join(dirname(require.resolve("magicast")), "builders-pgs2P7Vh.js"), "utf8");
	assert.match(builders, /import \* as import_source_map from "source-map-js"/);
	assert.doesNotMatch(builders, /function IndexedSourceMapConsumer|require_source_map_consumer/);
	const css = postcss().process("a { color: red }", { from: "input.css", to: "output.css", map: { prev: indexed(0), inline: false } });
	assert.ok(css.map.toJSON().mappings);
	const module = parseModule("export default { enabled: false };", { sourceFileName: "input.js" });
	module.exports.default.enabled = true;
	const result = generateCode(module, { sourceMapName: "output.js", inputSourceMap: indexed(0) });
	assert.match(result.code, /enabled: true/);
	assert.ok(result.map.mappings);
	assert.throws(() => generateCode(module, { sourceMapName: "output.js", inputSourceMap: indexed(Infinity) }), /non-negative integers/);
});

test("reverse lookup retains child-owned relative and rooted source normalization", () => {
	const rooted = { ...flat, sourceRoot: "/src" };
	for (const map of [indexed(2, 5, rooted), indexed(1, 0, indexed(1, 5, rooted))]) {
		const consumer = new SourceMapConsumer(map);
		for (const source of ["input.js", "/src/input.js"]) {
			assert.deepEqual(consumer.generatedPositionFor({ source, line: 1, column: 0 }), { line: 3, column: 5 });
		}
		assert.deepEqual(consumer.generatedPositionFor({ source: "missing.js", line: 1, column: 0 }), { line: null, column: null });
	}
});
