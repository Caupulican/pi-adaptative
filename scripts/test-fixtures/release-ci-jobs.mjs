export function completeCiJobs() {
	return [
		{ name: "Build, check (ubuntu-latest)", steps: ["Build", "Check", "Provider regressions", "Dependency fork installation"] },
		{ name: "Build, check (windows-latest)", steps: ["Build", "Provider regressions", "Dependency hardening", "Dependency fork installation"] },
	].map((job) => ({ ...job, status: "completed", conclusion: "success", steps: job.steps.map((name) => ({ name, conclusion: "success" })) }));
}
