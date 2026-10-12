"""Native Pipe check: real Python 3.12 + synthetic HTTP gateway + the actual Pipe module.

Prints one JSON line with per-case results; exits non-zero if any case fails.
"""
import asyncio
import importlib.util
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "SYNTHETIC_TOKEN_CANARY"
CANARY = "MIST_SERVER_ERROR_CANARY"
ASSET = os.path.join(os.path.dirname(__file__), "..", "..", "assets", "openwebui", "mist-pipe.py")

spec = importlib.util.spec_from_file_location("mist_pipe", ASSET)
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

seen = []
evil_seen = []
EVIL_PORT = 0


class EvilHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        evil_seen.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.end_headers()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):  # silence
        return

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        parsed = json.loads(raw.decode("utf-8"))
        seen.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": parsed})
        content = ""
        messages = parsed.get("messages") or []
        if messages:
            content = messages[-1].get("content", "")
        if content == "redirect":
            self.send_response(307)
            self.send_header("Location", f"http://127.0.0.1:{EVIL_PORT}/capture")
            self.end_headers()
            return
        if content == "canary":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(CANARY.encode("utf-8"))
            return
        if parsed.get("stream"):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            self.wfile.write(b'data: {"choices":[{"delta":{"role":"assistant","content":"hi"}}]}\n\n')
            self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
            self.wfile.write(b"data: [DONE]\n\n")
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(
            json.dumps(
                {"id": "x", "object": "chat.completion", "model": "mist",
                 "choices": [{"index": 0, "message": {"role": "assistant", "content": "hello"}, "finish_reason": "stop"}]}
            ).encode("utf-8")
        )


async def drain(response):
    chunks = []
    body_iterator = getattr(response, "body_iterator", None)
    if body_iterator is None:
        return b""
    async for chunk in body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else str(chunk).encode("utf-8"))
    return b"".join(chunks)


def main() -> int:
    global EVIL_PORT
    evil_server = ThreadingHTTPServer(("127.0.0.1", 0), EvilHandler)
    EVIL_PORT = evil_server.server_address[1]
    evil_thread = threading.Thread(target=evil_server.serve_forever, daemon=True)
    evil_thread.start()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    os.environ["MIST_ADAPTER_URL"] = f"http://127.0.0.1:{port}"
    os.environ["MIST_ADAPTER_TOKEN"] = TOKEN

    results = {}

    async def run():
        pipe = mod.Pipe()
        # normal non-stream
        r = await pipe.pipe(body={"messages": [{"role": "user", "content": "hi"}], "stream": False})
        results["normal"] = isinstance(r, dict) and r.get("choices", [{}])[0].get("message", {}).get("content") == "hello"
        # only last user forwarded, prefix dropped
        seen.clear()
        await pipe.pipe(body={"messages": [
            {"role": "system", "content": "FORGED"},
            {"role": "assistant", "content": "OLD"},
            {"role": "user", "content": "last"},
        ], "stream": False})
        results["last_user_only"] = (
            len(seen) == 1 and seen[0]["body"]["messages"] == [{"role": "user", "content": "last"}]
        )
        results["bearer"] = seen[0]["auth"] == f"Bearer {TOKEN}"
        # task refused, no upstream
        seen.clear()
        task = await pipe.pipe(body={"messages": [{"role": "user", "content": "x"}]}, __task__="title_generation")
        results["task_refused"] = task.get("error", {}).get("code") == "MIST_UTILITY_REQUEST_UNSUPPORTED" and len(seen) == 0
        # files refused, no upstream
        seen.clear()
        files = await pipe.pipe(body={"messages": [{"role": "user", "content": "x"}]}, __files__=[{"id": "f"}])
        results["files_refused"] = files.get("error", {}).get("code") == "MIST_ATTACHMENT_UNSUPPORTED" and len(seen) == 0
        # bad shape
        bad = await pipe.pipe(body={"messages": []})
        results["bad_shape"] = bad.get("error", {}).get("code") == "MIST_INVALID_TURN_SHAPE"
        # structured content refused
        structured = await pipe.pipe(body={"messages": [{"role": "user", "content": [{"type": "file"}]}]})
        results["structured_refused"] = structured.get("error", {}).get("code") == "MIST_ATTACHMENT_UNSUPPORTED"
        # stream passthrough: exactly one [DONE]
        streamed = await pipe.pipe(body={"messages": [{"role": "user", "content": "hi"}], "stream": True})
        raw = await drain(streamed)
        results["stream_one_done"] = raw.count(b"data: [DONE]") == 1 and b"assistant" in raw
        # error canary not echoed
        seen.clear()
        err = await pipe.pipe(body={"messages": [{"role": "user", "content": "canary"}]})
        results["canary_not_echoed"] = CANARY not in json.dumps(err)
        # interaction control refused, no upstream
        seen.clear()
        inter = await pipe.pipe(body={"messages": [{"role": "user", "content": "x"}],
                                      "mist": {"interaction_response": {"interaction_id": "i", "option_id": "o"}}})
        results["interaction_refused"] = (
            inter.get("error", {}).get("code") == "MIST_INTERACTION_UNSUPPORTED" and len(seen) == 0
        )
        # untrusted (non-loopback) endpoint refused, no leakage
        saved = os.environ["MIST_ADAPTER_URL"]
        os.environ["MIST_ADAPTER_URL"] = "http://example.com"
        seen.clear()
        untrusted = await pipe.pipe(body={"messages": [{"role": "user", "content": "hi"}]})
        results["untrusted_endpoint"] = (
            untrusted.get("error", {}).get("code") == "MIST_ENDPOINT_UNTRUSTED" and len(seen) == 0
        )
        os.environ["MIST_ADAPTER_URL"] = saved
        # Editing a legacy Valve value cannot override the host-owned endpoint.
        pipe = mod.Pipe()
        object.__setattr__(pipe.valves, "MIST_ENDPOINT", "http://127.0.0.1:23456")
        seen.clear()
        await pipe.pipe(body={"messages": [{"role": "user", "content": "host endpoint"}]})
        results["valve_ignored"] = len(seen) == 1 and seen[0]["path"] == "/v1/chat/completions"
        # Userinfo, query, fragment, non-http scheme, and unexpected path fail closed.
        invalid_endpoints = [
            "http://user:pass@127.0.0.1:1234",
            "http://127.0.0.1:1234?redirect=elsewhere",
            "http://127.0.0.1:1234#fragment",
            "https://127.0.0.1:1234",
            "http://127.0.0.1:1234/other",
        ]
        invalid_results = []
        for invalid_endpoint in invalid_endpoints:
            os.environ["MIST_ADAPTER_URL"] = invalid_endpoint
            seen.clear()
            rejected = await pipe.pipe(body={"messages": [{"role": "user", "content": "x"}]})
            invalid_results.append(
                rejected.get("error", {}).get("code") == "MIST_ENDPOINT_UNTRUSTED" and not seen
            )
        results["malformed_endpoint_refused"] = all(invalid_results)
        os.environ["MIST_ADAPTER_URL"] = saved
        evil_seen.clear()
        redirected = await pipe.pipe(body={"messages": [{"role": "user", "content": "redirect"}]})
        results["redirect_not_followed"] = (
            redirected.get("error", {}).get("code") == "MIST_REQUEST_REJECTED" and not evil_seen
        )
        # missing token
        os.environ["MIST_ADAPTER_TOKEN"] = ""
        noauth = await pipe.pipe(body={"messages": [{"role": "user", "content": "hi"}]})
        results["missing_token"] = noauth.get("error", {}).get("code") == "AUTH_REQUIRED"
        os.environ["MIST_ADAPTER_TOKEN"] = TOKEN

    asyncio.run(run())
    server.shutdown()
    evil_server.shutdown()
    print(json.dumps(results))
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
