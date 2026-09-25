/**
 * CI runner load evidence (Windows): what is consuming the machine when tests stall. Shared by the
 * per-test stall report and the run's global setup.
 *
 * Nothing here starts PowerShell for the core numbers: on a stalled runner a cold PowerShell could not
 * start within 40 s, so a PowerShell-based sampler reported nothing exactly when it mattered. CPU comes
 * from os.cpus() deltas (no process), process creation latency from a bare `cmd /c exit`, and the
 * busiest processes from `tasklist`, a native executable.
 */
import { execFile } from "node:child_process";
import { cpus, freemem } from "node:os";

function cpuTimes(): { idle: number; total: number } {
	let idle = 0;
	let total = 0;
	for (const cpu of cpus()) {
		const { user, nice, sys, irq, idle: cpuIdle } = cpu.times;
		idle += cpuIdle;
		total += user + nice + sys + irq + cpuIdle;
	}
	return { idle, total };
}

/** Milliseconds to start and finish `cmd /c exit 0`: how fast this runner creates a process right now. */
function spawnLatency(): Promise<string> {
	const startedAt = Date.now();
	return new Promise((resolve) => {
		execFile("cmd.exe", ["/d", "/c", "exit 0"], { timeout: 60_000, windowsHide: true }, (error) =>
			resolve(
				error
					? `failed after ${Date.now() - startedAt} ms (${error.message.slice(0, 80)})`
					: `${Date.now() - startedAt} ms`,
			),
		);
	});
}

/** The processes with the most CPU time since they started, from `tasklist /v` (h:mm:ss CPU Time column). */
function busiestByCpuTime(): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"tasklist.exe",
			["/v", "/fo", "csv", "/nh"],
			{ timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve(`tasklist failed: ${error.message.slice(0, 120)}`);
				const rows = stdout
					.split(/\r?\n/u)
					.map((line) => line.match(/"([^"]*)"/gu)?.map((cell) => cell.slice(1, -1)) ?? [])
					.filter((cells) => cells.length >= 8)
					.map((cells) => {
						const [hours = 0, minutes = 0, seconds = 0] = (cells[7] ?? "").split(":").map(Number);
						return {
							name: cells[0],
							pid: cells[1],
							seconds: hours * 3600 + minutes * 60 + seconds,
							memory: cells[4],
						};
					})
					.filter((row) => row.pid !== "0")
					.sort((a, b) => b.seconds - a.seconds)
					.slice(0, 10);
				resolve(rows.map((row) => `${row.name}(${row.pid}) ${row.seconds}s ${row.memory}`).join(", "));
			},
		);
	});
}

export async function sampleRunnerLoad(): Promise<string> {
	const before = cpuTimes();
	const [latency, busiest] = await Promise.all([
		spawnLatency(),
		busiestByCpuTime(),
		new Promise((resolve) => setTimeout(resolve, 1_500)),
	]);
	const after = cpuTimes();
	const total = after.total - before.total;
	const busy = total > 0 ? Math.round((100 * (total - (after.idle - before.idle))) / total) : 0;
	return `cpu busy ${busy}% over the sample, free memory ${Math.round(freemem() / 1024 / 1024)} MB, process start ${latency}; most CPU time since start: ${busiest}`;
}

/** Whether Defender real-time protection is scanning this runner, and its exclusions. */
export function defenderStatus(): Promise<string> {
	const script =
		"$s = Get-MpComputerStatus; $p = Get-MpPreference; @{ realtime = $s.RealTimeProtectionEnabled; exclusions = @($p.ExclusionPath) } | ConvertTo-Json -Compress";
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 40_000, windowsHide: true },
			(error, stdout) =>
				resolve(error ? `defender status failed: ${error.message.slice(0, 120)}` : `defender ${stdout.trim()}`),
		);
	});
}
