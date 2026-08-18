#!/usr/bin/env bash
set -euo pipefail

# Bounded Linux system dependency installer for CI workflows.
# Separates retriable network downloads from a single local package installation.
# Enforces hard process-tree termination via timeout --kill-after.

UPDATE_TIMEOUT="${CI_APT_UPDATE_TIMEOUT:-45s}"
DOWNLOAD_TIMEOUT="${CI_APT_DOWNLOAD_TIMEOUT:-90s}"
INSTALL_TIMEOUT="${CI_APT_INSTALL_TIMEOUT:-120s}"
KILL_AFTER="${CI_APT_KILL_AFTER:-5s}"
MAX_ATTEMPTS="${CI_APT_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${CI_APT_RETRY_DELAY:-2}"

APT_OPTS=(
	-o "Acquire::http::Timeout=15"
	-o "Acquire::https::Timeout=15"
	-o "Acquire::Retries=3"
	-o "Dpkg::Options::=--force-confdef"
	-o "Dpkg::Options::=--force-confold"
)

PACKAGES=(
	libcairo2-dev
	libpango1.0-dev
	libjpeg-dev
	libgif-dev
	librsvg2-dev
	fd-find
	ripgrep
)

# Phase 1: Bounded / retriable package list update
echo "==> [Phase 1/3] Updating package lists with bounded retries..."
update_ok=0
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
	echo "--> apt-get update (attempt ${attempt}/${MAX_ATTEMPTS})..."
	if timeout --kill-after="${KILL_AFTER}" "${UPDATE_TIMEOUT}" sudo apt-get update "${APT_OPTS[@]}"; then
		update_ok=1
		break
	else
		echo "Warning: apt-get update attempt ${attempt} timed out or failed. Retrying..."
		sleep "${RETRY_DELAY}"
	fi
done

if [ "${update_ok}" -ne 1 ]; then
	echo "Error: apt-get update failed after ${MAX_ATTEMPTS} bounded attempts." >&2
	exit 1
fi

# Phase 2: Bounded / retriable network package download (download-only, non-mutating)
echo "==> [Phase 2/3] Downloading packages (download-only, non-mutating)..."
download_ok=0
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
	echo "--> apt-get install --download-only (attempt ${attempt}/${MAX_ATTEMPTS})..."
	if timeout --kill-after="${KILL_AFTER}" "${DOWNLOAD_TIMEOUT}" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --download-only "${APT_OPTS[@]}" "${PACKAGES[@]}"; then
		download_ok=1
		break
	else
		echo "Warning: apt-get download-only attempt ${attempt} timed out or failed. Retrying..."
		sleep "${RETRY_DELAY}"
	fi
done

if [ "${download_ok}" -ne 1 ]; then
	echo "Error: apt-get download-only failed after ${MAX_ATTEMPTS} bounded attempts." >&2
	exit 1
fi

# Phase 3: Single bounded local package installation (no network fetch, no loop retry)
echo "==> [Phase 3/3] Applying local package installation (single attempt, no-download)..."
if ! timeout --kill-after="${KILL_AFTER}" "${INSTALL_TIMEOUT}" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-download "${APT_OPTS[@]}" "${PACKAGES[@]}"; then
	echo "Error: local apt-get install failed or timed out during package application. Refusing to retry mutating dpkg state." >&2
	exit 1
fi

# Ensure 'fd' binary alias exists if installed as 'fdfind'
if ! command -v fd >/dev/null 2>&1; then
	fdfind_bin=$(command -v fdfind || true)
	if [ -n "${fdfind_bin}" ]; then
		sudo ln -sf "${fdfind_bin}" /usr/local/bin/fd
	fi
fi

# Phase 4: Validation of all requested packages, tools, and native modules
echo "==> Verifying all requested packages via dpkg-query..."
for pkg in "${PACKAGES[@]}"; do
	if ! dpkg-query -W -f='${Status}\n' "${pkg}" 2>/dev/null | grep -q "ok installed"; then
		echo "Error: package '${pkg}' is not installed properly." >&2
		exit 1
	fi
done

echo "==> Verifying installed tools..."
for tool in fd rg pkg-config; do
	if ! command -v "${tool}" >/dev/null 2>&1; then
		echo "Error: required tool '${tool}' is missing after installation." >&2
		exit 1
	fi
done

echo "==> Verifying native library modules via pkg-config..."
for mod in cairo pango librsvg-2.0; do
	if ! pkg-config --exists "${mod}"; then
		echo "Error: required pkg-config module '${mod}' is missing after installation." >&2
		exit 1
	fi
done

echo "==> All Linux CI system dependencies and tools verified successfully."
