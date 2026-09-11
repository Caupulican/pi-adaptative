import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquirePersistentShellSession,
	buildBashWire,
	disposePersistentShellSession,
	type PersistentShellSession,
	ShellExportLedger,
} from "../src/core/tools/shell-session.ts";

function bashAvailable(): boolean {
	try {
		return spawnSync("bash", ["-c", "true"], { encoding: "utf-8", timeout: 15_000 }).status === 0;
	} catch {
		return false;
	}
}

const HAS_BASH = process.platform !== "win32" && bashAvailable();

const BASELINE = ['declare -x HOME="/home/x"', 'declare -x PATH="/usr/bin"'].join("\n");

describe("ShellExportLedger", () => {
	it("starts from the first listing as the baseline and applies nothing to a lane that matches it", () => {
		const ledger = new ShellExportLedger();
		ledger.record(undefined, BASELINE);
		expect(ledger.version).toBe(0);
		expect(ledger.preludeFor(undefined)).toBeUndefined();
		expect(ledger.preludeFor(BASELINE)).toBeUndefined();
	});

	it("merges each lane's own delta, so a sibling's stale snapshot never erases an export", () => {
		const ledger = new ShellExportLedger();
		ledger.record(undefined, BASELINE);
		// Lane A exports FOO.
		const laneA = `${BASELINE}\ndeclare -x FOO="1"`;
		ledger.record(undefined, laneA);
		expect(ledger.version).toBe(1);
		expect(ledger.names()).toContain("FOO");
		// Lane B, which started before A finished, reports the baseline it still holds: no delta.
		ledger.record(undefined, BASELINE);
		expect(ledger.version).toBe(1);
		expect(ledger.names()).toContain("FOO");
		// B now needs FOO; A needs nothing.
		expect(ledger.preludeFor(BASELINE)).toBe('declare -x FOO="1"');
		expect(ledger.preludeFor(laneA)).toBeUndefined();
	});

	it("propagates an unset and a changed value, measured against the lane's previous listing", () => {
		const ledger = new ShellExportLedger();
		ledger.record(undefined, BASELINE);
		const withFoo = `${BASELINE}\ndeclare -x FOO="1"`;
		ledger.record(undefined, withFoo);
		// Lane A changes FOO and unsets PATH.
		const changed = 'declare -x FOO="2"\ndeclare -x HOME="/home/x"';
		ledger.record(withFoo, changed);
		expect(ledger.version).toBe(2);
		// A lane that last saw FOO=1 with PATH replays the new value and the unset.
		expect(ledger.preludeFor(withFoo)).toBe('declare -x FOO="2"\nunset -v PATH');
		// A lane that never reported (baseline) needs FOO and the unset.
		expect(ledger.preludeFor(undefined)).toBe('declare -x FOO="2"\nunset -v PATH');
	});

	it("ignores listing lines that are not exported variables", () => {
		const ledger = new ShellExportLedger();
		ledger.record(undefined, 'garbage line\ndeclare -x OK="1"');
		expect(ledger.names()).toEqual(["OK"]);
	});
});

describe("bash wire v2", () => {
	it("frames exit code, directory and the changed export listing by byte length", () => {
		const wire = buildBashWire("true", "abc123", null);
		expect(wire).toContain("__pi_exports=$(unset -v _ PWD OLDPWD SHLVL; export -p)");
		expect(wire).toContain(":v2:%s:%s:%s:%s:%s:%s:%s");
		expect(wire).toContain("__PI_EXPORT_SNAPSHOT");
		expect(wire).toContain("unset -v _ PWD OLDPWD SHLVL; export -p");
		expect(wire).toContain("unset -v __pi_status __pi_exports __pi_exports_before __pi_exports_out");
	});
});

describe.skipIf(!HAS_BASH)("exports shared across bash lanes", () => {
	const keys: string[] = [];

	function lane(): PersistentShellSession {
		const key = `pi-export-sync-${randomUUID()}`;
		keys.push(key);
		return acquirePersistentShellSession(key, "bash");
	}

	async function run(session: PersistentShellSession, command: string, ledger: ShellExportLedger) {
		const chunks: Buffer[] = [];
		const result = await session.exec(command, process.cwd(), {
			onData: (data) => chunks.push(data),
			exportLedger: ledger,
		});
		return {
			exitCode: result.exitCode,
			output: Buffer.concat(chunks).toString("utf8").trim(),
			exports: result.exports,
		};
	}

	afterEach(async () => {
		await Promise.all(keys.splice(0).map((key) => disposePersistentShellSession(key)));
	});

	it("an export on one lane is visible on another lane's next command; an unset propagates too", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		const b = lane();
		// A first command that changes nothing reports no listing; the lane's baseline seeds the ledger.
		expect((await run(a, "true", ledger)).exports).toBeUndefined();
		expect((await run(b, "true", ledger)).exports).toBeUndefined();
		expect(ledger.version).toBe(0);

		expect(await run(a, "export PI_SYNC_A=one", ledger)).toMatchObject({ exitCode: 0, output: "" });
		expect(ledger.version).toBe(1);
		expect((await run(b, 'echo "[$PI_SYNC_A]"', ledger)).output).toBe("[one]");

		expect((await run(a, "unset PI_SYNC_A", ledger)).exitCode).toBe(0);
		expect(ledger.version).toBe(2);
		expect((await run(b, "printenv PI_SYNC_A || echo unset", ledger)).output).toBe("unset");
	});

	it("an export made by a lane's very first command still reaches a lane that has never run anything", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		const b = lane();
		expect((await run(a, "export PI_SYNC_FIRST=first", ledger)).exitCode).toBe(0);
		expect(ledger.version).toBe(1);
		expect((await run(b, 'echo "[$PI_SYNC_FIRST]"', ledger)).output).toBe("[first]");
	});

	it("a cd on one lane is never replayed as an export on another", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		const b = lane();
		expect((await run(a, "cd /tmp", ledger)).exitCode).toBe(0);
		expect(ledger.version).toBe(0);
		expect(ledger.names()).not.toContain("PWD");
		expect((await run(b, "pwd", ledger)).output).toBe(process.cwd());
	});

	it("values with newlines, quotes and the record separator survive the frame and the replay", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		const b = lane();
		await run(a, "true", ledger);
		await run(b, "true", ledger);
		expect((await run(a, "export PI_SYNC_Q=$'a\\nb\"c\\x1e d'", ledger)).exitCode).toBe(0);
		expect(
			(await run(b, '[ "$PI_SYNC_Q" = $\'a\\nb"c\\x1e d\' ] && echo same || echo different', ledger)).output,
		).toBe("same");
	});

	it("a command that changes nothing reports no listing and costs no replay", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		await run(a, "true", ledger);
		const second = await run(a, "echo steady", ledger);
		expect(second.output).toBe("steady");
		expect(second.exports).toBeUndefined();
		expect(ledger.version).toBe(0);
	});

	it("two lanes exporting concurrently both contribute, whichever finishes first", async () => {
		const ledger = new ShellExportLedger();
		const a = lane();
		const b = lane();
		const c = lane();
		await Promise.all([run(a, "true", ledger), run(b, "true", ledger), run(c, "true", ledger)]);
		await Promise.all([
			run(a, "sleep 0.3; export PI_SYNC_X=x", ledger),
			run(b, "export PI_SYNC_Y=y; sleep 0.1", ledger),
		]);
		expect(ledger.names()).toEqual(expect.arrayContaining(["PI_SYNC_X", "PI_SYNC_Y"]));
		expect((await run(c, 'echo "$PI_SYNC_X$PI_SYNC_Y"', ledger)).output).toBe("xy");
	});
});
