#!/usr/bin/env python3
"""Tiny OpenAI-compatible chat sidecar for pi-managed Hugging Face Transformers models.

Intentionally stdlib-only at the server layer: the managed venv supplies torch,
transformers, and huggingface_hub, while HTTP serving stays dependency-free so pi
does not need FastAPI/Uvicorn just to run a suggested local model.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

_MODEL_ID = ""
_TOKENIZER: Any = None
_MODEL: Any = None
_TORCH: Any = None
_DEVICE = "cpu"
_FUNCTION_CALL_RE = re.compile(r"<function\b[^>]*>.*?</function>", re.DOTALL)
_FUNCTION_NAME_RE = re.compile(r"<function\b[^>]*\bname=(['\"])(.*?)\1", re.DOTALL)
_PARAM_RE = re.compile(r"<param\b[^>]*\bname=(['\"])(.*?)\1[^>]*>(.*?)</param>", re.DOTALL)


def _json_response(handler: BaseHTTPRequestHandler, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _message_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts)
    return "" if content is None else str(content)


def _decode_arguments(arguments: Any) -> Any:
    if isinstance(arguments, str):
        try:
            return json.loads(arguments)
        except json.JSONDecodeError as error:
            raise ValueError(f"tool_call function.arguments must be valid JSON: {error.msg}") from error
    return arguments


def _normalize_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(tool_calls, list):
        return normalized
    for tool_call in tool_calls:
        if not isinstance(tool_call, dict):
            continue
        function = tool_call.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        normalized_call: dict[str, Any] = {
            "type": "function",
            "function": {"name": name, "arguments": _decode_arguments(function.get("arguments"))},
        }
        tool_call_id = tool_call.get("id")
        if isinstance(tool_call_id, str) and tool_call_id:
            normalized_call["id"] = tool_call_id
        normalized.append(normalized_call)
    return normalized


def _normalize_messages(messages: Any) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    if not isinstance(messages, list):
        return normalized
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = message.get("role")
        if role == "developer":
            role = "system"
        if role not in {"system", "user", "assistant", "tool"}:
            role = "user"
        normalized_message: dict[str, Any] = {"role": str(role), "content": _message_text(message.get("content"))}
        if role == "assistant":
            tool_calls = _normalize_tool_calls(message.get("tool_calls"))
            if tool_calls:
                normalized_message["tool_calls"] = tool_calls
        if role == "tool":
            tool_call_id = message.get("tool_call_id")
            if isinstance(tool_call_id, str) and tool_call_id:
                normalized_message["tool_call_id"] = tool_call_id
        normalized.append(normalized_message)
    return normalized


def _render_prompt(messages: list[dict[str, Any]], tools: Any) -> str:
    tokenizer = _TOKENIZER
    kwargs: dict[str, Any] = {
        "tokenize": False,
        "add_generation_prompt": True,
    }
    if isinstance(tools, list) and tools:
        kwargs["tools"] = tools
    return tokenizer.apply_chat_template(messages, **kwargs)


def _generation_options(request: dict[str, Any]) -> dict[str, Any]:
    max_tokens = request.get("max_completion_tokens", request.get("max_tokens", 512))
    try:
        max_new_tokens = max(1, min(int(max_tokens), 2048))
    except Exception:
        max_new_tokens = 512

    temperature_value = request.get("temperature", 0.0)
    try:
        temperature = float(temperature_value)
    except Exception:
        temperature = 0.0
    do_sample = temperature > 0.0

    return {
        "max_new_tokens": max_new_tokens,
        "do_sample": do_sample,
        **({"temperature": temperature} if do_sample else {}),
    }


def _clean_generated_text(text: str) -> str:
    tokenizer = _TOKENIZER
    eos = getattr(tokenizer, "eos_token", None)
    if eos:
        text = text.replace(eos, "")
    pad = getattr(tokenizer, "pad_token", None)
    if pad and pad != eos:
        text = text.replace(pad, "")
    return text.strip()


def _decode_param_value(raw: str) -> Any:
    stripped = raw.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            return json.loads(stripped)
        except Exception:
            return stripped
    return stripped


def _extract_native_function_calls(text: str) -> tuple[str, list[dict[str, Any]]]:
    calls: list[dict[str, Any]] = []
    spans: list[tuple[int, int]] = []
    for match in _FUNCTION_CALL_RE.finditer(text):
        block = match.group(0)
        name_match = _FUNCTION_NAME_RE.search(block)
        if not name_match:
            continue
        name = html.unescape(name_match.group(2).strip())
        if not name:
            continue
        arguments: dict[str, Any] = {}
        for param_match in _PARAM_RE.finditer(block):
            param_name = html.unescape(param_match.group(2).strip())
            if not param_name:
                continue
            arguments[param_name] = _decode_param_value(html.unescape(param_match.group(3)))
        calls.append(
            {
                "id": f"call_{uuid.uuid4().hex}",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(arguments, ensure_ascii=False)},
            }
        )
        spans.append(match.span())
    if not calls:
        return text, []
    remaining_parts: list[str] = []
    cursor = 0
    for start, end in spans:
        remaining_parts.append(text[cursor:start])
        cursor = end
    remaining_parts.append(text[cursor:])
    return "".join(remaining_parts).strip(), calls


def _function_call_stopping_criteria(prompt_token_count: int) -> Any:
    from transformers import StoppingCriteria, StoppingCriteriaList

    class StopAfterFunctionCall(StoppingCriteria):
        def __call__(self, input_ids: Any, _scores: Any, **_kwargs: Any) -> bool:
            generated_ids = input_ids[0][prompt_token_count:]
            if int(generated_ids.shape[-1]) == 0:
                return False
            text = _TOKENIZER.decode(generated_ids, skip_special_tokens=False)
            return bool(_FUNCTION_CALL_RE.search(text))

    return StoppingCriteriaList([StopAfterFunctionCall()])


def _generate(request: dict[str, Any]) -> str:
    tokenizer = _TOKENIZER
    model = _MODEL
    torch = _TORCH
    messages = _normalize_messages(request.get("messages"))
    prompt = _render_prompt(messages, request.get("tools"))
    encoded = tokenizer(prompt, return_tensors="pt")
    encoded = {key: value.to(_DEVICE) for key, value in encoded.items()}
    input_length = int(encoded["input_ids"].shape[-1])
    options = _generation_options(request)
    eos_token_id = getattr(tokenizer, "eos_token_id", None)
    pad_token_id = getattr(tokenizer, "pad_token_id", None) or eos_token_id
    generation_args: dict[str, Any] = {
        **encoded,
        "eos_token_id": eos_token_id,
        "pad_token_id": pad_token_id,
        **options,
    }
    if isinstance(request.get("tools"), list) and request.get("tools"):
        generation_args["stopping_criteria"] = _function_call_stopping_criteria(input_length)
    with torch.inference_mode():
        output = model.generate(**generation_args)
    generated = output[0][input_length:]
    return _clean_generated_text(tokenizer.decode(generated, skip_special_tokens=False))


def _stream_chunk(handler: BaseHTTPRequestHandler, chunk: dict[str, Any]) -> None:
    handler.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode("utf-8"))
    handler.wfile.flush()


class Handler(BaseHTTPRequestHandler):
    server_version = "pi-hf-transformers/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path == "/health":
            _json_response(self, 200, {"ok": True, "model": _MODEL_ID})
            return
        if self.path == "/v1/models":
            _json_response(
                self,
                200,
                {"object": "list", "data": [{"id": _MODEL_ID, "object": "model", "owned_by": "pi"}]},
            )
            return
        _json_response(self, 404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        if self.path != "/v1/chat/completions":
            _json_response(self, 404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
            request = json.loads(self.rfile.read(length).decode("utf-8"))
            text = _generate(request)
            content, tool_calls = _extract_native_function_calls(text)
            if request.get("stream", False):
                self.send_response(200)
                self.send_header("content-type", "text/event-stream")
                self.send_header("cache-control", "no-cache")
                self.end_headers()
                chunk_id = f"chatcmpl-pi-{uuid.uuid4().hex}"
                created = int(time.time())
                _stream_chunk(
                    self,
                    {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": _MODEL_ID,
                        "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                    },
                )
                if content:
                    _stream_chunk(
                        self,
                        {
                            "id": chunk_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": _MODEL_ID,
                            "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}],
                        },
                    )
                for index, tool_call in enumerate(tool_calls):
                    _stream_chunk(
                        self,
                        {
                            "id": chunk_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": _MODEL_ID,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {
                                        "tool_calls": [
                                            {
                                                "index": index,
                                                "id": tool_call["id"],
                                                "type": "function",
                                                "function": tool_call["function"],
                                            }
                                        ]
                                    },
                                    "finish_reason": None,
                                }
                            ],
                        },
                    )
                _stream_chunk(
                    self,
                    {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": _MODEL_ID,
                        "choices": [
                            {"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool_calls else "stop"}
                        ],
                    },
                )
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return

            _json_response(
                self,
                200,
                {
                    "id": f"chatcmpl-pi-{uuid.uuid4().hex}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": _MODEL_ID,
                    "choices": [
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": content if content else None,
                                **({"tool_calls": tool_calls} if tool_calls else {}),
                            },
                            "finish_reason": "tool_calls" if tool_calls else "stop",
                        }
                    ],
                },
            )
        except Exception as exc:  # pragma: no cover - surfaced to the TypeScript caller as HTTP 500
            traceback.print_exc()
            _json_response(self, 500, {"error": str(exc)})


def _download_only(model_id: str, cache_dir: str) -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(repo_id=model_id, cache_dir=cache_dir)


def _load_model(model_id: str, cache_dir: str, device: str) -> None:
    global _MODEL_ID, _TOKENIZER, _MODEL, _TORCH, _DEVICE

    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    threads = os.environ.get("PI_TRANSFORMERS_THREADS")
    if threads:
        try:
            torch.set_num_threads(max(1, int(threads)))
        except Exception:
            pass

    dtype_name = os.environ.get("PI_TRANSFORMERS_TORCH_DTYPE", "float32")
    torch_dtype = getattr(torch, dtype_name, torch.float32)
    tokenizer = AutoTokenizer.from_pretrained(model_id, cache_dir=cache_dir)
    model = AutoModelForCausalLM.from_pretrained(model_id, cache_dir=cache_dir, torch_dtype=torch_dtype)
    model.to(device)
    model.eval()

    _MODEL_ID = model_id
    _TOKENIZER = tokenizer
    _MODEL = model
    _TORCH = torch
    _DEVICE = device


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=18100)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--device", default=os.environ.get("PI_TRANSFORMERS_DEVICE", "cpu"))
    parser.add_argument("--download-only", action="store_true")
    args = parser.parse_args()

    os.makedirs(args.cache_dir, exist_ok=True)
    if args.download_only:
        _download_only(args.model_id, args.cache_dir)
        return

    _load_model(args.model_id, args.cache_dir, args.device)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"pi hf-transformers server ready model={args.model_id} url=http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
