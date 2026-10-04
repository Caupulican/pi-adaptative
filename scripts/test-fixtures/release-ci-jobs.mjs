export function completeCiJobs() {
	return [
		{ name: "Build, check (ubuntu-latest)", steps: ["Build", "Check"] },
		{ name: "Build, check (windows-latest)", steps: ["Build"] },
	].map((job) => ({ ...job, status: "completed", conclusion: "success", steps: job.steps.map((name) => ({ name, conclusion: "success" })) }));
}
