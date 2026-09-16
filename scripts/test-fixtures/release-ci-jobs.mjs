export function completeCiJobs() {
	return [
		{ name: "Build, check, test (ubuntu-latest)", steps: ["Verification-harness coverage gate", "Test non-coding-agent workspaces", "Test native process-tree control alone"] },
		{ name: "Build, check, test (windows-latest)", steps: ["Test non-coding-agent workspaces", "Test native process-tree control alone", "Test native incident collector with Windows PowerShell 5.1"] },
		...["ubuntu-latest", "windows-latest"].flatMap((os) => [1, 2, 3, 4].map((shard) => ({ name: `Coding-agent test (${os}, shard ${shard}/4)`, steps: ["Test coding-agent shard"] }))),
	].map((job) => ({ ...job, status: "completed", conclusion: "success", steps: job.steps.map((name) => ({ name, conclusion: "success" })) }));
}
