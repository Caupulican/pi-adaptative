"use strict";

const fill = require("fill-range");

const PATTERN_DEPTH_LIMIT = 128;
const PATTERN_NODE_LIMIT = 65536;
const PATTERN_RESULT_LIMIT = 10000;
const PATTERN_BYTE_LIMIT = 8 * 1024 * 1024;

function pushPatternBlock(stack, block) {
	if (stack.length > PATTERN_DEPTH_LIMIT) throw new RangeError("Pi pattern nesting limit exceeded");
	stack.push(block);
}

/** Containment and ancestry are different graphs: normal parent/prev backlinks remain valid. */
function validatePatternStructure(root) {
	const pending = [{ node: root, depth: 0, leaving: false }];
	const active = new Set();
	let scheduled = 1;
	let bytes = 0;
	while (pending.length) {
		const { node, depth, leaving } = pending.pop();
		if (leaving) { active.delete(node); continue; }
		if (!node || typeof node !== "object" || depth > PATTERN_DEPTH_LIMIT + 1 || active.has(node) ||
			(node.nodes !== undefined && depth > PATTERN_DEPTH_LIMIT))
			throw new RangeError("Pi pattern containment limit exceeded");
		active.add(node);
		pending.push({ node, depth, leaving: true });
		if (typeof node.value === "string") bytes += node.value.length;
		if (bytes > PATTERN_BYTE_LIMIT) throw new RangeError("Pi pattern text limit exceeded");
		const parents = new Set();
		let parent = node;
		while (parent) {
			if (typeof parent !== "object" || parents.has(parent) || parents.size >= PATTERN_DEPTH_LIMIT + 2)
				throw new RangeError("Pi pattern ancestry limit exceeded");
			parents.add(parent);
			parent = parent.parent;
		}
		if (node.nodes === undefined) continue;
		if (!Array.isArray(node.nodes)) throw new RangeError("Invalid Pi pattern node list");
		scheduled += node.nodes.length;
		if (scheduled > PATTERN_NODE_LIMIT) throw new RangeError("Pi pattern node limit exceeded");
		for (let index = node.nodes.length - 1; index >= 0; index--)
			pending.push({ node: node.nodes[index], depth: depth + 1, leaving: false });
	}
}

function createPatternBudget() { return { items: 0, bytes: 0, rangeItems: 0, rangeBytes: 0 }; }

function appendPatternResult(result, value, budget) {
	budget.items++;
	if (typeof value === "string") budget.bytes += value.length;
	if (budget.items > PATTERN_RESULT_LIMIT || budget.bytes > PATTERN_BYTE_LIMIT)
		throw new RangeError("Pi pattern expansion budget exceeded");
	result.push(value);
}

/** Admit before fill-range materializes stepped regexes or arrays; its unit-step regex is compact. */
function fillPatternRange(args, options, budget) {
	if (args.length !== 2 && args.length !== 3) throw new RangeError("Invalid Pi pattern range arguments");
	const [start, end, explicitStep] = args;
	const stepValue = explicitStep || options.step || 1;
	// An object here makes upstream recursively reinterpret it as new options and loses admission.
	if (typeof stepValue !== "number" && typeof stepValue !== "string")
		throw new TypeError("Invalid Pi pattern range step type");
	const numericStep = Number(stepValue);
	// Invalid steps retain fill-range's existing empty-result/strictRanges contract.
	if (!Number.isInteger(numericStep)) return fill(...args, options);
	if (!Number.isSafeInteger(numericStep)) throw new RangeError("Pi pattern unsafe range step");
	const step = Math.max(Math.abs(numericStep), 1);
	let first = Number(start);
	let last = Number(end);
	const numeric = Number.isInteger(first) && Number.isInteger(last);
	if (numeric) {
		if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
			throw new RangeError("Pi pattern unsafe range endpoint");
	} else {
		// Invalid multi-character letter endpoints never enter fill-range's allocation loop.
		if ((!Number.isInteger(first) && start.length > 1) || (!Number.isInteger(last) && end.length > 1))
			return fill(...args, options);
		first = String(start).charCodeAt(0);
		last = String(end).charCodeAt(0);
	}
	if (options.toRegex && step === 1) return fill(...args, options);
	const difference = BigInt(first) - BigInt(last);
	const count = (difference < 0n ? -difference : difference) / BigInt(step) + 1n;
	const requested = options.rangeLimit === undefined ? (options.toRegex ? PATTERN_RESULT_LIMIT : 1000) : options.rangeLimit;
	const limit = typeof requested === "number" && Number.isFinite(requested) && requested >= 0
		? Math.min(Math.floor(requested), PATTERN_RESULT_LIMIT) : PATTERN_RESULT_LIMIT;
	const width = numeric ? Math.max(String(start).length, String(end).length, String(stepValue).length, 17) : 1;
	if (count > BigInt(limit) || count * BigInt(width) > BigInt(PATTERN_BYTE_LIMIT))
		throw new RangeError("Pi pattern range limit exceeded before allocation");
	budget.rangeItems += Number(count);
	budget.rangeBytes += Number(count) * (width + 4);
	if (budget.rangeItems > PATTERN_RESULT_LIMIT || budget.rangeBytes > PATTERN_BYTE_LIMIT)
		throw new RangeError("Pi pattern aggregate range budget exceeded before allocation");
	return fill(...args, options);
}

function checkedPatternOutputLength(length, addition) {
	const next = length + addition;
	if (next > PATTERN_BYTE_LIMIT) throw new RangeError("Pi pattern compilation output budget exceeded");
	return next;
}

function appendPatternOutput(parts, value, length) {
	const next = checkedPatternOutputLength(length, value.length);
	parts.push(value);
	return next;
}

function joinPatternOutput(...parts) {
	let length = 0;
	for (const part of parts) length = checkedPatternOutputLength(length, part.length);
	return parts.join("");
}

module.exports = {
	pushPatternBlock, validatePatternStructure, createPatternBudget, appendPatternResult, fillPatternRange,
	appendPatternOutput, joinPatternOutput,
};
