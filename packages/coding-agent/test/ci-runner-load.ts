/**
 * CI runner load evidence (Windows): what is consuming the machine when tests stall. Shared by the
 * per-test stall report and the run's global setup.
 */
import { execFile } from "node:child_process";

/** What is consuming the runner: per-process CPU seconds over a 1.5 s window, overall load, free memory. */
export function sampleRunnerLoad(): Promise<string> {
	const script = [
		"$before = @{}; Get-Process | ForEach-Object { $before[$_.Id] = [double]$_.CPU }",
		"Start-Sleep -Milliseconds 1500",
		"$load = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average",
		"$freeMb = [math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)",
		"$top = Get-Process | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Name = $_.Name; Cpu = [math]::Round([double]$_.CPU - [double]$before[$_.Id], 2); Mb = [math]::Round($_.WorkingSet64 / 1MB) } } | Sort-Object Cpu -Descending | Select-Object -First 10",
		"$d = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\"",
		"$disk = 'read {0} ms, write {1} ms, queue {2}, idle {3}%' -f ($d.AvgDisksecPerRead * 1000), ($d.AvgDisksecPerWrite * 1000), $d.CurrentDiskQueueLength, $d.PercentIdleTime",
		"@{ load = $load; freeMb = $freeMb; disk = ($disk -join ', '); top = @($top) } | ConvertTo-Json -Compress -Depth 3",
	].join("; ");
	return new Promise((resolve) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", script],
			{ timeout: 40_000, maxBuffer: 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				if (error) return resolve(`load sample failed: ${error.message.slice(0, 200)}`);
				try {
					const sample = JSON.parse(stdout) as {
						load: number;
						freeMb: number;
						disk: string;
						top: Array<{ Id: number; Name: string; Cpu: number; Mb: number }>;
					};
					const busiest = sample.top.map((row) => `${row.Name}(${row.Id}) ${row.Cpu}s ${row.Mb}MB`).join(", ");
					resolve(
						`cpu load ${sample.load}%, free memory ${sample.freeMb} MB, disk ${sample.disk}; busiest over 1.5 s: ${busiest}`,
					);
				} catch (parseError) {
					resolve(`load sample unparsable: ${String(parseError).slice(0, 200)}`);
				}
			},
		);
	});
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
				resolve(error ? `defender status failed: ${error.message.slice(0, 200)}` : `defender ${stdout.trim()}`),
		);
	});
}
