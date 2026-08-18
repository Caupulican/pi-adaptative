#!/usr/bin/env bash
set -euo pipefail

# Bounded Linux system dependency installer for Ubuntu CI workflows.
# Strictly validates Ubuntu OS identity, codename, and trusted archive keyring.
# Generates and enforces a minimal, CI-owned Ubuntu HTTPS repository source definition,
# bypassing unresponsive runner Azure mirrorlists and third-party package repositories.
# Separates retriable network downloads from a single local package installation.
# Enforces hard process-tree termination via timeout --kill-after.

UPDATE_TIMEOUT="${CI_APT_UPDATE_TIMEOUT:-40s}"
DOWNLOAD_TIMEOUT="${CI_APT_DOWNLOAD_TIMEOUT:-60s}"
INSTALL_TIMEOUT="${CI_APT_INSTALL_TIMEOUT:-90s}"
KILL_AFTER="${CI_APT_KILL_AFTER:-5s}"
MAX_ATTEMPTS="${CI_APT_MAX_ATTEMPTS:-2}"
RETRY_DELAY="${CI_APT_RETRY_DELAY:-1}"

# OS-release and keyring validation
OS_RELEASE_FILE="${CI_OS_RELEASE_PATH:-/etc/os-release}"
if [ ! -r "${OS_RELEASE_FILE}" ]; then
	echo "Error: os-release file '${OS_RELEASE_FILE}' is missing or unreadable." >&2
	exit 1
fi

# Parse os-release
OS_ID=$(. "${OS_RELEASE_FILE}" && echo "${ID:-}")
if [ "${OS_ID}" != "ubuntu" ]; then
	echo "Error: unsupported Linux distribution '${OS_ID}'. This installer requires Ubuntu (ID=ubuntu)." >&2
	exit 1
fi

CODENAME=$(. "${OS_RELEASE_FILE}" && echo "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
if [[ -z "${CODENAME}" || ! "${CODENAME}" =~ ^[a-z]+$ ]]; then
	echo "Error: invalid or missing Ubuntu codename '${CODENAME}'. Expected a single lowercase token (e.g. noble, jammy)." >&2
	exit 1
fi

KEYRING_FILE="${CI_KEYRING_PATH:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"
if [ ! -r "${KEYRING_FILE}" ] || [ ! -s "${KEYRING_FILE}" ]; then
	echo "Error: Ubuntu archive keyring '${KEYRING_FILE}' is missing, empty, or unreadable." >&2
	exit 1
fi

# Set up clean temporary directory for CI-owned sources definition
TMP_DIR=$(mktemp -d "/tmp/ci-apt-sources-XXXXXX")
trap 'rm -rf "${TMP_DIR}"' EXIT

SOURCES_FILE="${TMP_DIR}/ci-sources.list"
SOURCES_PARTS_DIR="${TMP_DIR}/sources.list.d"
mkdir -p "${SOURCES_PARTS_DIR}"

# Generate minimal, clean, official HTTPS sources definition
cat <<EOF > "${SOURCES_FILE}"
deb [signed-by=${KEYRING_FILE}] https://archive.ubuntu.com/ubuntu/ ${CODENAME} main universe
deb [signed-by=${KEYRING_FILE}] https://archive.ubuntu.com/ubuntu/ ${CODENAME}-updates main universe
deb [signed-by=${KEYRING_FILE}] https://security.ubuntu.com/ubuntu/ ${CODENAME}-security main universe
EOF

# Assert generated sources contain no Azure mirrors or third-party repositories
if grep -Eqi '(azure|microsoft|google|github|nodesource|docker|datadog)' "${SOURCES_FILE}"; then
	echo "Error: CI sources definition contains forbidden azure or third-party mirrors." >&2
	exit 1
fi

APT_OPTS=(
	-o "Dir::Etc::sourcelist=${SOURCES_FILE}"
	-o "Dir::Etc::sourceparts=${SOURCES_PARTS_DIR}"
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
echo "==> [Phase 1/3] Updating package lists with bounded retries via official HTTPS mirrors..."
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
