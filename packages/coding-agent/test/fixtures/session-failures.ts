/** Synthetic failure shapes only: no recorded transcript, user content, or runtime identifiers. */
export const aliasReactivationFixture = {
	cwd: "/fixture/repository",
	alias: "p/example.ts",
	path: "src/example.ts",
	content: "export const example = true;\n",
	activationCount: 2,
};

export const verificationCwdFixture = {
	workspaceRoot: "/fixture/repository",
	incorrectCwd: "/fixture/repository/packages/example",
	correctedCwd: "/fixture/repository",
	command: "node --test test/example.test.mjs",
	setupOutput: "Could not find 'test/example.test.mjs'",
};

export const workbenchCounterFixture = {
	firstCycle: [true, false],
	secondCycle: [false],
	firstSummary: "2 actions · 1 failure receipts",
	secondSummary: "1 actions · 1 failure receipts",
};
