"""Exercise the native Pipe over the active listener and assembled resident runtime."""
import asyncio
import importlib.util
import json
from pathlib import Path

asset = Path(__file__).parents[2] / "assets" / "openwebui" / "mist-pipe.py"
spec = importlib.util.spec_from_file_location("mist_pipe", asset)
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

async def drain(response):
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk if isinstance(chunk, bytes) else str(chunk).encode("utf-8"))
    return b"".join(chunks)

async def main():
    pipe = module.Pipe()
    normal = await pipe.pipe(body={"model": "ignored", "stream": False,
                                   "messages": [{"role": "user", "content": "native-pipe-turn"}]})
    streamed = await pipe.pipe(body={"model": "ignored", "stream": True,
                                     "messages": [{"role": "user", "content": "native-pipe-stream"}]})
    stream_wire = await drain(streamed)
    files = await pipe.pipe(body={"messages": [{"role": "user", "content": "should not be sent"}]},
                            __files__=[{"id": "synthetic-file"}])
    task = await pipe.pipe(body={"messages": [{"role": "user", "content": "should not be sent"}]},
                           __task__="title_generation")
    interaction = await pipe.pipe(body={"messages": [{"role": "user", "content": "should not be sent"}],
                                        "mist": {"interaction_response": {"interaction_id": "i", "option_id": "o"}}})
    print(json.dumps({
        "normal": normal.get("choices", [{}])[0].get("message", {}).get("content"),
        "stream_has_reply": b"native-pipe-stream-reply" in stream_wire,
        "stream_done_count": stream_wire.count(b"data: [DONE]"),
        "attachment_code": files.get("error", {}).get("code"),
        "task_code": task.get("error", {}).get("code"),
        "interaction_code": interaction.get("error", {}).get("code"),
    }))

asyncio.run(main())
