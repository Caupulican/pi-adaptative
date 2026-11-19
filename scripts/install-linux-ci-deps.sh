#!/usr/bin/env bash
set -euo pipefail

# Bounded Linux system dependency installer for Ubuntu CI workflows.
# Strictly validates Ubuntu OS identity, codename, and trusted archive keyring.
# Generates and enforces a minimal, CI-owned Ubuntu HTTPS repository source definition,
# bypassing unresponsive runner Azure mirrorlists and third-party package repositories.
# Separates retriable network downloads from a single local package installation.
# Enforces hard process-tree termination via timeout --kill-after.

UPDATE_TIMEOUT="${CI_APT_UPDATE_TIMEOUT:-90s}"
DOWNLOAD_TIMEOUT="${CI_APT_DOWNLOAD_TIMEOUT:-120s}"
INSTALL_TIMEOUT="${CI_APT_INSTALL_TIMEOUT:-90s}"
KILL_AFTER="${CI_APT_KILL_AFTER:-5s}"
MAX_ATTEMPTS="${CI_APT_MAX_ATTEMPTS:-2}"
RETRY_DELAY="${CI_APT_RETRY_DELAY:-1}"

# OS-release and keyring validation
OS_RELEASE_FILE="${CI_OS_RELEASE_PATH:-/etc/os-release}"
if [ ! -f "${OS_RELEASE_FILE}" ] || [ ! -r "${OS_RELEASE_FILE}" ]; then
	echo "Error: os-release file '${OS_RELEASE_FILE}' is missing or unreadable." >&2
	exit 1
fi

# Clear inherited values and source the trusted os-release file once
unset ID UBUNTU_CODENAME VERSION_CODENAME
# shellcheck source=/dev/null
. "${OS_RELEASE_FILE}"

OS_ID="${ID:-}"
if [ "${OS_ID}" != "ubuntu" ]; then
	echo "Error: unsupported Linux distribution '${OS_ID}'. This installer requires Ubuntu (ID=ubuntu)." >&2
	exit 1
fi

CODENAME="${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}"
if [[ -z "${CODENAME}" || ! "${CODENAME}" =~ ^[a-z]+$ ]]; then
	echo "Error: invalid or missing Ubuntu codename '${CODENAME}'. Expected a single lowercase token (e.g. noble, jammy)." >&2
	exit 1
fi

KEYRING_FILE="${CI_KEYRING_PATH:-/usr/share/keyrings/ubuntu-archive-keyring.gpg}"
if [[ ! "${KEYRING_FILE}" =~ ^/[a-zA-Z0-9_./-]+$ ]]; then
	echo "Error: invalid keyring path '${KEYRING_FILE}'. Expected an absolute single-token path without whitespace, brackets, or special characters." >&2
	exit 1
fi

if [ ! -f "${KEYRING_FILE}" ] || [ ! -r "${KEYRING_FILE}" ] || [ ! -s "${KEYRING_FILE}" ]; then
	echo "Error: Ubuntu archive keyring '${KEYRING_FILE}' is missing, empty, or unreadable." >&2
	exit 1
fi

# Set up clean temporary directory for CI-owned sources definition
TMP_DIR=$(mktemp -d "/tmp/ci-apt-sources-XXXXXX")
trap 'rm -rf "${TMP_DIR}"' EXIT

SOURCES_FILE="${TMP_DIR}/ci-sources.list"
SOURCES_PARTS_DIR="${TMP_DIR}/sources.list.d"
mkdir -p "${SOURCES_PARTS_DIR}"

# Both transports serve the Ubuntu archive. The runner keyring authenticates each
# suite, and APT verifies package hashes against the signed indexes.
write_sources() {
	local archive="$1" security="$2"
	cat > "${SOURCES_FILE}" <<EOF
deb [signed-by=${KEYRING_FILE}] ${archive} ${CODENAME} main universe
deb [signed-by=${KEYRING_FILE}] ${archive} ${CODENAME}-updates main universe
deb [signed-by=${KEYRING_FILE}] ${security} ${CODENAME}-security main universe
EOF
}

APT_OPTS=(
	-o "Dir::Etc::sourcelist=${SOURCES_FILE}"
	-o "Dir::Etc::sourceparts=${SOURCES_PARTS_DIR}"
	-o "Acquire::http::Timeout=15"
	-o "Acquire::https::Timeout=15"
	-o "Acquire::Retries=1"
	-o "APT::Update::Error-Mode=any"
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

# Resolve and download against the same signed index. If either operation fails,
# retry the whole acquisition using a mirror on a different network.
acquired=0
for attempt in $(seq 1 "${MAX_ATTEMPTS}"); do
	if (( attempt % 2 == 1 )); then
		archive=https://archive.ubuntu.com/ubuntu/
		security=https://security.ubuntu.com/ubuntu/
	else
		archive=https://mirrors.edge.kernel.org/ubuntu/
		security="$archive"
	fi
	write_sources "$archive" "$security"
	echo "==> Fetching Ubuntu indexes from ${archive} (attempt ${attempt}/${MAX_ATTEMPTS})..."
	if timeout --kill-after="${KILL_AFTER}" "${UPDATE_TIMEOUT}" sudo apt-get update "${APT_OPTS[@]}" &&
		timeout --kill-after="${KILL_AFTER}" "${DOWNLOAD_TIMEOUT}" sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --download-only "${APT_OPTS[@]}" "${PACKAGES[@]}"; then
		acquired=1
		break
	fi
	echo "Warning: Ubuntu index or package download failed for ${archive}." >&2
	if (( attempt < MAX_ATTEMPTS )); then sleep "${RETRY_DELAY}"; fi
done
if (( ! acquired )); then
	echo "Error: could not acquire the Ubuntu packages after ${MAX_ATTEMPTS} bounded attempts." >&2
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
