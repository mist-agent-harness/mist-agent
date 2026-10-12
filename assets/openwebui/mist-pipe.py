"""
title: Mist OpenAI-compatible Pipe (text only)
author: mist
version: 0.2.0
required_open_webui_version: 0.11.4
description: >
  Routes Open WebUI chat through the Mist OpenAI-compatible adapter endpoint. Text only in
  D31-1: attachments and option/approval interactions are refused with a stable code and a
  Chinese remedy. Open WebUI reserved args (__task__ / __files__ / __user__ / __metadata__)
  arrive as keyword args per functions.py; the body carries the chat messages. The Bearer
  token is read from the process environment (MIST_ADAPTER_TOKEN) and never stored in Valves
  or this source. The endpoint is host-owned MIST_ADAPTER_URL.
"""

# mist-pipe-owner: mist_openai_pipe

from __future__ import annotations

import json
import os
from typing import Any, Iterator

import requests
from starlette.responses import StreamingResponse

try:  # real Open WebUI runtime provides pydantic
    from pydantic import BaseModel, Field
except Exception:  # pragma: no cover - importable for static checks without open-webui
    class BaseModel:  # type: ignore[no-redef]
        pass

    def Field(*_args: Any, **_kwargs: Any) -> Any:  # type: ignore[no-redef]
        return None


def _error(code: str, remedy: str) -> dict[str, Any]:
    return {"error": {"type": "mist_request_error", "code": code, "message": remedy, "param": None}}


def _content_parts(content: Any) -> Any:
    return content


class Pipe:
    """Open WebUI in-process Pipe Function; text-only bridge to the Mist adapter."""

    class Valves(BaseModel):
        # Non-secret only. The Bearer token must NOT live here (RT-06).
        MIST_MODEL_ALIAS: str = Field(default="mist")

    def __init__(self) -> None:
        self.type = "pipe"
        self.id = "mist-openai-pipe"
        self.name = "Mist (text)"
        self.valves = self.Valves()

    def pipes(self) -> list[dict[str, str]]:
        return [{"id": self.id, "name": self.name}]

    @staticmethod
    def _last_user(messages: Any) -> Any:
        if not isinstance(messages, list) or not messages:
            return None
        last = messages[-1]
        if not isinstance(last, dict) or last.get("role") != "user":
            return None
        return last.get("content")

    def _endpoint(self) -> str:
        # Only host process environment is authoritative; an editable Valve cannot redirect Bearer.
        base = os.environ.get("MIST_ADAPTER_URL", "").rstrip("/")
        # 规范一次 /v1：避免 http://host:port/v1 变成 /v1/v1/chat/completions。
        if base.endswith("/v1"):
            base = base[: -len("/v1")]
        return base

    async def pipe(
        self,
        body: dict[str, Any],
        __task__: str | None = None,
        __files__: list[Any] | None = None,
        __user__: dict[str, Any] | None = None,
        __metadata__: dict[str, Any] | None = None,
    ) -> Any:
        # Reserved args are first-class keyword parameters (functions.py passes them explicitly).
        del __user__
        task = __task__
        if task is None and isinstance(__metadata__, dict):
            task = __metadata__.get("task")
        if task:
            return _error(
                "MIST_UTILITY_REQUEST_UNSUPPORTED",
                "本步只支持纯文字聊天；后台任务请求不转发给住户。请在 Open WebUI 关闭标题/标签/跟进等任务模型。",
            )
        if __files__:
            return _error(
                "MIST_ATTACHMENT_UNSUPPORTED",
                "本步只支持纯文字聊天；附件尚未开放，请等待后续结构事件单，或先移除附件后重发。",
            )
        mist_field = body.get("mist") if isinstance(body, dict) else None
        if isinstance(mist_field, dict) and (
            "interaction_response" in mist_field or "interactionResponse" in mist_field
        ):
            return _error(
                "MIST_INTERACTION_UNSUPPORTED",
                "本步只支持纯文字聊天；选项/交互响应尚未开放，请等待后续结构事件单。",
            )
        messages = body.get("messages") if isinstance(body, dict) else None
        content = self._last_user(messages)
        if content is None:
            return _error("MIST_INVALID_TURN_SHAPE", "只消费 messages 最后一条 user；空或非 user 末尾会被拒绝。")
        if not isinstance(content, str):
            return _error("MIST_ATTACHMENT_UNSUPPORTED", "本步只支持纯文字；附件/结构化内容尚未开放。")

        token = os.environ.get("MIST_ADAPTER_TOKEN", "")
        if not token:
            return _error("AUTH_REQUIRED", "缺少 Bearer token；请由宿主把 MIST_ADAPTER_TOKEN 注入本进程环境。")
        endpoint = self._endpoint()
        if not endpoint:
            return _error("MIST_ENDPOINT_UNAVAILABLE", "Mist adapter 端点未配置；请由宿主注入 MIST_ADAPTER_URL。")
        # 端点只允许本机 loopback 固定来源：公共配置/Valves 不得把 Bearer 重定向到外部 host。
        from urllib.parse import urlparse

        parsed = urlparse(endpoint)
        if (
            parsed.scheme != "http"
            or parsed.hostname not in ("127.0.0.1", "localhost", "::1")
            or parsed.username is not None
            or parsed.password is not None
            or parsed.query
            or parsed.fragment
            or parsed.path not in ("", "/v1")
        ):
            return _error("MIST_ENDPOINT_UNTRUSTED", "adapter 端点必须是本机 loopback；拒绝把凭证发往外部 host。")

        stream = bool(body.get("stream", False))
        request_body = {
            "model": self.valves.MIST_MODEL_ALIAS,
            "stream": stream,
            "messages": [{"role": "user", "content": content}],
        }
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {token}"}
        try:
            response = requests.post(
                f"{endpoint}/v1/chat/completions",
                headers=headers,
                data=json.dumps(request_body),
                stream=stream,
                timeout=300,
                allow_redirects=False,
            )
        except Exception:
            return _error("MIST_ENDPOINT_UNAVAILABLE", "Mist adapter 不可达；请检查本机端点后重试。")
        if response.status_code != 200:
            response.close()
            return _error("MIST_REQUEST_REJECTED", f"Mist adapter 拒绝请求（HTTP {response.status_code}）。")
        if stream:
            return StreamingResponse(self._iter_sse(response), media_type="text/event-stream")
        try:
            payload = response.json()
        except Exception:
            response.close()
            return _error("MIST_RESPONSE_INVALID", "上游返回非 JSON；已按固定错误处理，不回显上游内容。")
        response.close()
        return payload

    def _iter_sse(self, response: "requests.Response") -> Iterator[bytes]:
        # 原样透传服务端 SSE（含唯一 [DONE]），不额外补 stop/[DONE]。
        try:
            for chunk in response.iter_content(chunk_size=None):
                if chunk:
                    yield chunk
        finally:
            response.close()
