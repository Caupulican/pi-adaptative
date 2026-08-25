#!/bin/sh
set -eu

REPOSITORY="https://github.com/Caupulican/pi-adaptative"
API_LATEST="https://api.github.com/repos/Caupulican/pi-adaptative/releases/latest"
HOME_DIR=${HOME:-}
INSTALL_DIR=${PI_INSTALL_DIR:-${XDG_DATA_HOME:-${HOME_DIR}/.local/share}/pi-adaptative}
BIN_DIR=${PI_BIN_DIR:-${HOME_DIR}/.local/bin}
VERSION=${PI_VERSION:-}
TEST_MODE=${PI_INSTALL_TEST_MODE:-0}
TEST_BASE=${PI_INSTALL_TEST_BASE_URL:-}
MARKER_NAME='.pi-adaptative-managed'
MARKER_CONTENT='pi-adaptative-managed-release-v1'

fail() {
	printf '%s\n' "install.sh: $*" >&2
	exit 1
}

ensure_managed_release() {
	release=$1
	marker="$release/$MARKER_NAME"
	if [ -L "$release" ] || [ ! -d "$release" ]; then
		fail "refusing to trust an incomplete managed release: $release"
	fi
	if [ -L "$marker" ] || [ -d "$marker" ]; then
		fail "refusing an invalid release ownership marker: $marker"
	fi
	if [ -e "$marker" ]; then
		[ -f "$marker" ] || fail "refusing an invalid release ownership marker: $marker"
		[ "$(cat "$marker")" = "$MARKER_CONTENT" ] || fail "refusing an invalid release ownership marker: $marker"
		return
	fi
	printf '%s\n' "$MARKER_CONTENT" > "$marker" || fail "could not write release ownership marker"
}

create_managed_marker() {
	release=$1
	marker="$release/$MARKER_NAME"
	if [ -e "$marker" ] || [ -L "$marker" ]; then
		fail "release archive contains the reserved ownership marker"
	fi
	printf '%s\n' "$MARKER_CONTENT" > "$marker" || fail "could not write release ownership marker"
}

trim_trailing_slashes() {
	value=$1
	while [ "${value%/}" != "$value" ]; do value=${value%/}; done
	printf '%s' "$value"
}

is_unsafe_root() {
	value=$1
	case "$value" in
		""|"/"|"/tmp"|"/var"|"/usr"|"/usr/local"|"/opt"|"/bin"|"/sbin"|"/etc"|"$HOME_DIR") return 0 ;;
	esac
	case "/$value/" in
		*/../*) return 0 ;;
	esac
	return 1
}

INSTALL_DIR=$(trim_trailing_slashes "$INSTALL_DIR")
BIN_DIR=$(trim_trailing_slashes "$BIN_DIR")
[ -n "$HOME_DIR" ] || fail "HOME is required"
case "$INSTALL_DIR" in /*) ;; *) fail "install root must be absolute" ;; esac
case "$BIN_DIR" in /*) ;; *) fail "bin root must be absolute" ;; esac
is_unsafe_root "$INSTALL_DIR" && fail "unsafe install root: $INSTALL_DIR"
is_unsafe_root "$BIN_DIR" && fail "unsafe bin root: $BIN_DIR"
[ "$INSTALL_DIR" != "$BIN_DIR" ] || fail "install and bin roots must differ"

command -v tar >/dev/null 2>&1 || fail "tar is required"
command -v awk >/dev/null 2>&1 || fail "awk is required"

if [ "$TEST_MODE" = "1" ]; then
	case "$TEST_BASE" in /*) ;; *) fail "PI_INSTALL_TEST_BASE_URL must be an absolute directory in test mode" ;; esac
	[ -d "$TEST_BASE" ] || fail "PI_INSTALL_TEST_BASE_URL must be an existing directory in test mode"
else
	command -v curl >/dev/null 2>&1 || fail "curl is required"
fi

download_file() {
	url=$1
	destination=$2
	if [ "$TEST_MODE" = "1" ]; then
		filename=${url##*/}
		cp "$TEST_BASE/$filename" "$destination" || fail "could not load test release asset $filename"
		return
	fi
	curl -fsSL --retry 3 --connect-timeout 10 --max-time "$3" -o "$destination" "$url"
}

OS=$(uname -s)
ARCH=$(uname -m)
case "$OS:$ARCH" in
	Linux:x86_64|Linux:amd64) ASSET="pi-linux-x64.tar.gz" ;;
	Linux:aarch64|Linux:arm64) ASSET="pi-linux-arm64.tar.gz" ;;
	MINGW*:*|MSYS*:*|CYGWIN*:*) fail "Windows requires the native PowerShell installer; install.sh supports Linux only" ;;
	*) fail "unsupported platform: $OS $ARCH" ;;
esac

if [ -n "$VERSION" ]; then
	case "$VERSION" in
		v[0-9]*|[0-9]*) RELEASE_TAG=${VERSION#v}; RELEASE_TAG="v$RELEASE_TAG" ;;
		*) fail "PI_VERSION must be a release version" ;;
	esac
else
	LATEST_JSON=$(mktemp "${TMPDIR:-/tmp}/pi-release.XXXXXX") || fail "could not create latest-release staging file"
	trap 'rm -f "$LATEST_JSON"' EXIT HUP INT TERM
	download_file "$API_LATEST" "$LATEST_JSON" 60 || fail "could not resolve the latest release"
	RELEASE_TAG=$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"/]*\)".*/\1/p' "$LATEST_JSON" | head -n 1)
	rm -f "$LATEST_JSON"
	trap - EXIT HUP INT TERM
	[ -n "$RELEASE_TAG" ] || fail "latest release did not contain a tag"
fi

printf '%s\n' "$RELEASE_TAG" | awk '/^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?(\+[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$/ { found = 1 } END { exit(found ? 0 : 1) }' ||
	fail "release tag is not a safe semantic version: $RELEASE_TAG"
case "$RELEASE_TAG" in *[!A-Za-z0-9._-]*) fail "release tag contains unsafe characters" ;; esac

mkdir -p "$INSTALL_DIR" "$BIN_DIR" || fail "could not create user-local install roots"
LOCK_DIR="$INSTALL_DIR/.install.lock"
mkdir "$LOCK_DIR" 2>/dev/null || fail "another install is already active"
STAGE=$(mktemp -d "$INSTALL_DIR/.staging.XXXXXX") || {
	rmdir "$LOCK_DIR" 2>/dev/null || true
	fail "could not create same-filesystem staging directory"
}
CURRENT="$INSTALL_DIR/current"
RELEASES="$INSTALL_DIR/releases"
ARCHIVE="$STAGE/$ASSET"
SUMS="$STAGE/SHA256SUMS"
LIST="$STAGE/archive.list"
EXTRACT="$STAGE/extract"
NEW_RELEASE=""
OLD_CURRENT=""
HAD_CURRENT=0
BIN_CREATED=0

cleanup() {
	rm -rf "$STAGE"
	rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM

DOWNLOAD_BASE="$REPOSITORY/releases/download/$RELEASE_TAG"
ARCHIVE_URL="$DOWNLOAD_BASE/$ASSET"
SUMS_URL="$DOWNLOAD_BASE/SHA256SUMS"
download_file "$ARCHIVE_URL" "$ARCHIVE" 300 || fail "could not download $ASSET"
download_file "$SUMS_URL" "$SUMS" 60 || fail "release is missing mandatory SHA256SUMS"

EXPECTED=$(awk -v asset="$ASSET" '
	{
		name = $NF
		if (name == asset || name == "*" asset) {
			candidates++
			if (NF == 2 && length($1) == 64 && $1 !~ /[^0-9A-Fa-f]/) {
				valid++
				digest = $1
			}
		}
	}
	END {
		if (candidates == 1 && valid == 1) print digest
		else exit 1
	}
' "$SUMS") || fail "SHA256SUMS must contain exactly one valid entry for $ASSET"

if command -v sha256sum >/dev/null 2>&1; then
	ACTUAL=$(sha256sum "$ARCHIVE" | awk '{ print $1 }')
elif command -v shasum >/dev/null 2>&1; then
	ACTUAL=$(shasum -a 256 "$ARCHIVE" | awk '{ print $1 }')
else
	fail "sha256sum or shasum is required for release verification"
fi
[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum verification failed for $ASSET"

tar -tzf "$ARCHIVE" > "$LIST" || fail "could not inspect release archive"
tar -tvzf "$ARCHIVE" > "$STAGE/archive.details" || fail "could not inspect release archive entries"
while IFS= read -r DETAIL; do
	case "$DETAIL" in
		l*|h*|b*|c*|p*|s*) fail "release archive contains a non-regular entry" ;;
	esac
done < "$STAGE/archive.details"
FOUND_ROOT=0
while IFS= read -r ENTRY; do
	[ -n "$ENTRY" ] || continue
	case "$ENTRY" in
		/*|../*|*/../*|*/..|*\\*) fail "unsafe path in release archive: $ENTRY" ;;
		pi|pi/*) FOUND_ROOT=1 ;;
		*) fail "release archive must contain only the top-level pi tree" ;;
	esac
done < "$LIST"
[ "$FOUND_ROOT" -eq 1 ] || fail "release archive has no top-level pi tree"

mkdir "$EXTRACT"
tar -xzf "$ARCHIVE" -C "$EXTRACT" || fail "could not extract release archive"
[ -x "$EXTRACT/pi/pi" ] || fail "release archive does not contain an executable pi"
STAGED_VERSION=$("$EXTRACT/pi/pi" --version 2>/dev/null) || fail "staged pi --version failed"
[ -n "$STAGED_VERSION" ] || fail "staged pi --version was empty"
EXPECTED_VERSION=${RELEASE_TAG#v}
[ "$STAGED_VERSION" = "$EXPECTED_VERSION" ] || fail "staged pi --version '$STAGED_VERSION' does not match $EXPECTED_VERSION"

if [ -L "$CURRENT" ]; then
	OLD_CURRENT=$(readlink "$CURRENT")
	case "$OLD_CURRENT" in
		"$INSTALL_DIR/releases"/*) ;;
		*) fail "refusing to replace an unowned current pointer" ;;
	esac
	HAD_CURRENT=1
elif [ -e "$CURRENT" ]; then
	fail "refusing to replace an unowned current pointer"
fi

if [ -L "$BIN_DIR/pi" ]; then
	[ "$(readlink "$BIN_DIR/pi")" = "$CURRENT/pi" ] || fail "refusing to replace an unowned pi launcher"
elif [ -e "$BIN_DIR/pi" ]; then
	fail "refusing to replace an unowned pi launcher"
fi

mkdir -p "$RELEASES"
NEW_RELEASE="$RELEASES/$RELEASE_TAG"
if [ "$HAD_CURRENT" -eq 1 ] && [ "$OLD_CURRENT" = "$NEW_RELEASE" ] && [ -x "$NEW_RELEASE/pi" ]; then
	ACTIVE_VERSION=$("$NEW_RELEASE/pi" --version 2>/dev/null) || fail "active pi --version failed"
	if [ "$ACTIVE_VERSION" != "$EXPECTED_VERSION" ]; then
		fail "active pi --version '$ACTIVE_VERSION' does not match $EXPECTED_VERSION"
	fi
	ensure_managed_release "$NEW_RELEASE"
	printf 'Already installed %s at %s\n' "$STAGED_VERSION" "$NEW_RELEASE"
	printf 'Ensure %s is on PATH to invoke pi.\n' "$BIN_DIR"
	exit 0
fi

if [ -e "$NEW_RELEASE" ] || [ -L "$NEW_RELEASE" ]; then
	fail "refusing to replace an unowned existing release: $NEW_RELEASE"
fi
create_managed_marker "$EXTRACT/pi"
mv "$EXTRACT/pi" "$NEW_RELEASE" || fail "could not install the versioned release tree"

if [ ! -L "$BIN_DIR/pi" ] && [ ! -e "$BIN_DIR/pi" ]; then
	ln -s "$CURRENT/pi" "$BIN_DIR/pi" || fail "could not create the pi launcher"
	BIN_CREATED=1
fi

ln -s "$NEW_RELEASE" "$STAGE/current"
mv -Tf "$STAGE/current" "$CURRENT" || fail "could not activate the new release"
if ! "$BIN_DIR/pi" --version >/dev/null 2>&1; then
	rm -f "$CURRENT"
	if [ "$HAD_CURRENT" -eq 1 ]; then
		ln -s "$OLD_CURRENT" "$STAGE/restore-current"
		mv -Tf "$STAGE/restore-current" "$CURRENT"
	fi
	[ "$BIN_CREATED" -eq 0 ] || rm -f "$BIN_DIR/pi"
	rm -rf "$NEW_RELEASE"
	fail "installed pi --version failed; previous release was preserved"
fi

for CANDIDATE in "$RELEASES"/*; do
	[ -e "$CANDIDATE" ] || [ -L "$CANDIDATE" ] || continue
	[ "$CANDIDATE" = "$NEW_RELEASE" ] || [ "$CANDIDATE" = "$OLD_CURRENT" ] || {
		CANDIDATE_NAME=${CANDIDATE##*/}
		case "$CANDIDATE_NAME" in
			v[0-9]*)
				[ -L "$CANDIDATE" ] || [ ! -d "$CANDIDATE" ] && continue
				CANDIDATE_MARKER="$CANDIDATE/$MARKER_NAME"
				[ -L "$CANDIDATE_MARKER" ] || [ ! -f "$CANDIDATE_MARKER" ] && continue
				[ "$(cat "$CANDIDATE_MARKER")" = "$MARKER_CONTENT" ] || continue
				rm -rf "$CANDIDATE" ;;
		esac
	}
done

printf 'Installed %s to %s\n' "$STAGED_VERSION" "$NEW_RELEASE"
printf 'Ensure %s is on PATH to invoke pi.\n' "$BIN_DIR"
