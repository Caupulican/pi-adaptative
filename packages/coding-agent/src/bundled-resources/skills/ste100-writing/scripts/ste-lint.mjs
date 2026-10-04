#!/usr/bin/env node
// Heuristic ASD-STE100-style linter. Reports candidates only; it never proves compliance.
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const levelFlag = args.indexOf("--level");
const level = levelFlag >= 0 ? Number(args[levelFlag + 1]) : 9;
if (!file || !Number.isFinite(level)) {
	console.error("usage: ste-lint.mjs <file> [--level 1-10]");
	process.exit(2);
}

const maxWords = level >= 9 ? 25 : level >= 7 ? 30 : level >= 5 ? 35 : Number.POSITIVE_INFINITY;
const checkVoice = level >= 6;
const checkForms = level >= 8;
const checkClusters = level >= 8;

const BE = "(?:is|are|was|were|be|been|being)";
const passive = new RegExp(`\\b${BE}\\s+(?:\\w+ly\\s+)?\\w+(?:ed|en)\\b`, "i");
const progressive = new RegExp(`\\b${BE}\\s+\\w+ing\\b`, "i");
const perfect = /\b(?:has|have|had)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/i;
const contraction = /\b\w+'(?:s|t|re|ve|ll|d|m)\b/i;
const nounCluster = /\b(?:[a-z][\w-]*\s+){3,}[a-z][\w-]*\b/i;
const STOP = new Set("a an the of to in on at by for with from and or but if then than that this these those is are was were be been being has have had do does did will would can could may might must shall should not no as it its into over under per via".split(" "));

const raw = readFileSync(file, "utf8");
const lines = raw.split(/\r?\n/);
let inFence = false;
const findings = [];
let sentenceCount = 0;

lines.forEach((line, index) => {
	if (/^\s*```/.test(line)) {
		inFence = !inFence;
		return;
	}
	if (inFence || /^\s*(#|\||>|-{3,}|\s*$)/.test(line)) return;
	const text = line.replace(/`[^`]*`/g, "CODE").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
	for (const sentence of text.split(/(?<=[.!?])\s+/)) {
		const words = sentence.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word));
		if (words.length === 0) continue;
		sentenceCount++;
		const flag = (kind, detail) => findings.push({ line: index + 1, kind, detail, sentence: sentence.trim().slice(0, 100) });
		if (words.length > maxWords) flag("long-sentence", `${words.length} words, limit ${maxWords}`);
		if (checkVoice && passive.test(sentence)) flag("passive?", "check the actor");
		if (checkForms && progressive.test(sentence)) flag("progressive", "use a simple tense");
		if (checkForms && perfect.test(sentence)) flag("perfect-tense", "use past or present");
		if (checkForms && contraction.test(sentence)) flag("contraction", "write the full words");
		if (checkClusters) {
			const run = sentence.match(nounCluster);
			if (run) {
				const content = run[0].toLowerCase().split(/\s+/).filter((word) => !STOP.has(word));
				if (content.length >= 4 && content.length === run[0].split(/\s+/).length) flag("noun-cluster?", `${content.length} words in a row`);
			}
		}
	}
});

for (const finding of findings) {
	console.log(`${file}:${finding.line}: ${finding.kind} (${finding.detail}): ${finding.sentence}`);
}
console.log(`level=${level} sentences=${sentenceCount} flagged=${findings.length} (heuristic, not a compliance proof)`);
process.exit(findings.length > 0 ? 1 : 0);
