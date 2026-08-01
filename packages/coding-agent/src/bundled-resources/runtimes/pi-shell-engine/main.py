"""Persistent coordinator: read JSON-line requests, run each AST, emit bounded terminal frames.

The sole composition root — wires the real expander (`expand.expand_word`), the real
command-substitution runner (`exec.run_command_substitution`), and the real builtin
registry (`commands.REGISTRY`) into an `ExecContext`. See
windows-shell-workpackages-2026-07-19.md §1.2/§1.3/§3.

The process deliberately owns no shell state between requests. Node remains authoritative and
passes the current cwd/environment on every request; the terminal frame carries the resulting
delta back before the next serialized request is admitted. Keeping the interpreter/imports warm
removes Python startup from every command without creating a second source of truth.
"""

from __future__ import annotations

import io
import json
import os
import sys
import time

import exec as exec_module
import parser as parser_module
import tokens as tokens_module
from context import ExecContext
from errors import ShellExit, UnsupportedConstruct
from expand import ParamExpansionError
from state import ShellState

RECORD_SEPARATOR = b"\x1e"
MAX_REQUEST_BYTES = 8 * 1024 * 1024


def _read_request() -> dict | None:
    raw = sys.stdin.buffer.readline(MAX_REQUEST_BYTES + 1)
    if not raw:
        return None
    if len(raw) > MAX_REQUEST_BYTES:
        raise ValueError(f"request exceeds {MAX_REQUEST_BYTES} bytes")
    decoded = json.loads(raw.decode("utf-8"))
    if not isinstance(decoded, dict):
        raise ValueError("request must be a JSON object")
    return decoded


class _OutputSink:
    """Binary sink that streams command output without retaining the whole result."""

    def write(self, data: bytes) -> int:
        written = sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
        return written

    def flush(self) -> None:
        sys.stdout.buffer.flush()


def _write_frame(
    request_id: str | None,
    exit_code: int,
    cwd: str,
    env_delta: dict,
    unsupported: dict | None,
) -> None:
    frame = {
        "exitCode": exit_code,
        "cwd": cwd,
        "envDelta": env_delta,
        "unsupported": unsupported,
    }
    if request_id is not None:
        frame["requestId"] = request_id
    # stderr is the control channel. Command stderr is explicitly merged into
    # the command-output sink by ExecContext, so this frame cannot collide with
    # arbitrary command bytes (including RECORD_SEPARATOR).
    sys.stderr.buffer.write(RECORD_SEPARATOR)
    sys.stderr.buffer.write(json.dumps(frame, separators=(",", ":")).encode("utf-8"))
    sys.stderr.buffer.write(RECORD_SEPARATOR)
    sys.stderr.buffer.flush()


def _write_terminal(
    request_id: str | None,
    exit_code: int,
    cwd: str,
    env_delta: dict,
    unsupported: dict | None,
) -> None:
    sys.stdout.buffer.flush()
    if request_id is not None:
        # The frame and output travel over independent pipes. A request-specific barrier on the
        # output pipe proves that every preceding command byte reached Node before it settles the
        # control frame. Random request ids make collision with command bytes negligible.
        sys.stdout.buffer.write(RECORD_SEPARATOR)
        sys.stdout.buffer.write(request_id.encode("ascii"))
        sys.stdout.buffer.write(RECORD_SEPARATOR)
        sys.stdout.buffer.flush()
    _write_frame(request_id, exit_code, cwd, env_delta, unsupported)


def _request_id(request: dict) -> str | None:
    request_id = request.get("requestId")
    if request_id is None:
        return None
    if not isinstance(request_id, str) or len(request_id) != 16 or any(
        char not in "0123456789abcdef" for char in request_id
    ):
        raise ValueError("requestId must be 16 lowercase hexadecimal characters")
    return request_id


def _run_request(request: dict) -> None:
    request_id = _request_id(request)
    command: str = request["command"]
    cwd: str = request["cwd"]
    env: dict[str, str] = dict(request.get("env") or {})
    timeout_ms = request.get("timeoutMs")
    powershell_path = request.get("powershellPath")
    if not isinstance(powershell_path, str) or not powershell_path:
        powershell_path = None

    original_env = dict(env)

    if not os.path.isdir(cwd):
        message = f"cwd does not exist: {cwd}"
        sys.stdout.buffer.write(message.encode("utf-8"))
        _write_terminal(
            request_id,
            2,
            cwd,
            {},
            {"code": "unsupported", "construct": "cwd-missing", "message": message},
        )
        return

    state = ShellState(cwd=cwd, env=env, powershell_path=powershell_path)
    output = _OutputSink()

    deadline = None
    if isinstance(timeout_ms, (int, float)) and timeout_ms > 0:
        deadline = time.monotonic() + (timeout_ms / 1000.0)

    from commands import REGISTRY  # noqa: PLC0415 - deferred so WP-C is testable without commands/
    from expand import expand_word  # noqa: PLC0415 - deferred so WP-C is testable without expand.py

    ctx = ExecContext(
        state=state,
        # Coordinator stdin is the request channel. Commands must observe the same immediate EOF
        # they received from the former one-shot process, never consume a future protocol line.
        stdin=io.BytesIO(),
        stdout=output,
        expand_word=expand_word,
        run_command_substitution=exec_module.run_command_substitution,
        builtins=REGISTRY,
        deadline=deadline,
        stderr=output,
    )

    try:
        tokens = tokens_module.tokenize(command)
        ast = parser_module.parse(tokens)
        exit_code = exec_module.execute(ast, ctx)
    except ShellExit as exc:
        _write_terminal(request_id, exc.exit_code, state.cwd, state.delta(original_env), None)
        return
    except UnsupportedConstruct as exc:
        output.write(exc.message.encode("utf-8", errors="replace"))
        _write_terminal(
            request_id,
            2,
            state.cwd,
            state.delta(original_env),
            {"code": exc.code, "construct": exc.construct, "message": exc.message},
        )
        return
    except ParamExpansionError as exc:
        output.write(f"bash: {exc.name}: {exc.message}\n".encode("utf-8", errors="replace"))
        _write_terminal(request_id, 1, state.cwd, state.delta(original_env), None)
        return
    except (OSError, ValueError, UnicodeError) as exc:
        # Expected command/builtin failures must remain framed and must never
        # leak a Python traceback into the host shell protocol.
        output.write(f"shell: {exc}\n".encode("utf-8", errors="replace"))
        _write_terminal(request_id, 1, state.cwd, state.delta(original_env), None)
        return
    except Exception as exc:
        # Last-resort protocol boundary: preserve a bounded, actionable error
        # while keeping the control frame parseable.
        output.write(f"shell engine internal error: {type(exc).__name__}: {exc}\n".encode("utf-8", errors="replace"))
        _write_terminal(request_id, 1, state.cwd, state.delta(original_env), None)
        return

    _write_terminal(request_id, exit_code, state.cwd, state.delta(original_env), None)


def main() -> int:
    while True:
        try:
            request = _read_request()
        except (json.JSONDecodeError, UnicodeError, ValueError) as exc:
            # Without a trustworthy request id there is no safe frame to correlate. Terminate the
            # coordinator; the Node owner rejects the active command and lazily starts a clean one.
            sys.stderr.write(f"shell coordinator protocol error: {exc}\n")
            sys.stderr.flush()
            return 2
        if request is None:
            return 0
        try:
            _run_request(request)
        except (KeyError, TypeError, ValueError, UnicodeError) as exc:
            sys.stderr.write(f"shell coordinator invalid request: {exc}\n")
            sys.stderr.flush()
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
