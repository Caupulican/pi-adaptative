# Managed data tools

Pi keeps source filtering and structured-data projection outside the JavaScript heap with managed native tools:

- `rg` for bounded text and file candidate searches.
- `jq` for selecting only the JSON records and fields needed by the agent.
- Rust `jscpd` 5.0.14 for production clone evidence.

Pi provisions these binaries under its managed agent `bin` directory and places that directory first on the tool environment `PATH`. Provisioning never runs a project package manager and never writes dependencies, configuration, reports, or caches into the current repository.

The npm package includes the exact jscpd v5 platform package. Standalone releases carry the native binary beside Pi. The first Pi startup, `pi doctor`, or direct `jscpd` wrapper invocation installs the verified binary into managed storage. Concurrent sessions converge on the same exact version; different agent directories remain isolated.

Use `pi doctor` to verify availability. If a managed binary cannot be verified, treat the scan as incomplete and change approach; do not install a fallback into the project.

Ad hoc scanner reports and configuration belong in the OS or Pi transient work directory. A green clone report is evidence only when its production coverage and detection thresholds are also verified.
