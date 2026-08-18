#!/usr/bin/env bash
set -euo pipefail

# Bounded Linux system dependency installer for CI workflows.
# Protects against archive mirror and network stalls by enforcing socket timeouts,
# retry limits, per-step command bounds, and verifying required tools/libraries.

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

echo "==> Updating package lists with bounded retries..."
update_ok=0
for attempt in 1 2 3; do
	echo "--> apt-get update (attempt ${attempt}/3)..."
	if timeout 45s sudo apt-get update "${APT_OPTS[@]}"; then
		update_ok=1
		break
	else
		echo "Warning: apt-get update attempt ${attempt} timed out or failed. Retrying..."
		sleep 2
	fi
done

if [ "${update_ok}" -ne 1 ]; then
	echo "Error: apt-get update failed after 3 bounded attempts." >&2
	exit 1
fi

echo "==> Installing required system packages: ${PACKAGES[*]}..."
install_ok=0
for attempt in 1 2 3; do
	echo "--> apt-get install (attempt ${attempt}/3)..."
	if timeout 120s sudo DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_OPTS[@]}" "${PACKAGES[@]}"; then
		install_ok=1
		break
	else
		echo "Warning: apt-get install attempt ${attempt} timed out or failed. Retrying..."
		sleep 2
	fi
done

if [ "${install_ok}" -ne 1 ]; then
	echo "Error: apt-get install failed after 3 bounded attempts." >&2
	exit 1
fi

# Ensure 'fd' binary alias exists if installed as 'fdfind'
if ! command -v fd >/dev/null 2>&1; then
	fdfind_bin=$(command -v fdfind || true)
	if [ -n "${fdfind_bin}" ]; then
		sudo ln -sf "${fdfind_bin}" /usr/local/bin/fd
	fi
fi

echo "==> Verifying installed tools and native library dependencies..."
for tool in fd rg pkg-config; do
	if ! command -v "${tool}" >/dev/null 2>&1; then
		echo "Error: required tool '${tool}' is missing after installation." >&2
		exit 1
	fi
done

for pkg in cairo pango librsvg-2.0; do
	if ! pkg-config --exists "${pkg}"; then
		echo "Error: required pkg-config module '${pkg}' is missing after installation." >&2
		exit 1
	fi
done

echo "==> Linux CI system dependencies verified successfully."
