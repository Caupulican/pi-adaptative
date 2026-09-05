# Optional Herdr installation

Herdr supports collaboration. For Pi **0.98.1 and later supported stable versions**, the Linux `install.sh` and native Windows `install.ps1` installers ensure it after verifying and activating Pi, including when the same Pi release is already installed. `pi update self` (also `pi update pi` or `pi update --self`) uses these installers from both source/package-manager and standalone installations.

Older CLIs accept unknown long flags as session/extension input rather than refusing them. Both installers therefore gate `--provision-herdr` on the already verified release version and never probe an older executable with that flag. Legacy or unrecognized versions produce an explicit `Skipping Herdr provisioning` notice while Pi installation still succeeds. The conservative guard accepts only canonical `major.minor.patch` stable versions with at most nine digits per component; prereleases, build suffixes, leading zeroes, and other forms are skipped.

The activated Pi executable runs `--provision-herdr`, which delegates to the existing Herdr provisioner and pinned managed-tool downloader. The installers do not maintain another Herdr release URL, checksum, extraction path, or downloader, and do not run the general doctor or install unrelated tools.

Output starts with `Checking Herdr (optional collaboration)...`. A fresh download shows the managed downloader's progress; an existing binary needs no download. The final line reports either:

- `[OK] Herdr` with the resolved path and whether the command is exposed on PATH.
- `[WARN] Herdr` with the provisioning failure and `Pi remains usable`.

Offline mode, unsupported platforms, download errors, and unsafe PATH exposure do not fail or roll back a successful Pi installation. Herdr remains optional; this command never starts its service or creates a collaboration session. In particular, a Windows ARM64 Pi release does not imply that a matching pinned Herdr binary is available.

The installer temporarily supplies its launcher directory on the provisioning process's PATH. The provisioner only exposes a command in a safe, writable directory under the user's home; it never overwrites an unrelated command or edits shell profiles. On Windows, the managed executable and its runtime stay together and a `herdr.cmd` launcher supplies PATH exposure. If no safe exposure directory exists, the report identifies the managed binary as not exposed on PATH.

For a targeted retry without opening a session or provisioning other tools:

```sh
pi --provision-herdr
```

`pi doctor` also ensures and reports Herdr through the same owner. Missing optional Herdr appears as a warning, not a required-tool failure. The old updater's general post-update preflight does not repeat Herdr provisioning: the newly activated release already owns it, and extension-only updates must not introduce a Herdr installation.

Tests use isolated fixtures and injected provisioning outcomes; they do not download real Herdr or start services. Every Windows installer archive fixture contains a real Windows PE compiled once and shared across cases, with per-release version data beside it; shell text is never packaged as `pi.exe`. PE signatures are checked before packaging, and fixture tests require the native Windows compiler rather than substituting an invalid executable. Release acceptance should additionally exercise the packaged executable on each target platform.
