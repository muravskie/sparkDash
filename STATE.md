# Extension state

Updated: 2026-10-16

Design lives in [EXTENSIONS.md](EXTENSIONS.md). This file is only status.

## Repo

| | |
| --- | --- |
| Fork | https://github.com/muravskie/sparkDash |
| `origin` | `https://github.com/muravskie/sparkDash.git` |
| `upstream` | `https://github.com/MiaAI-Lab/sparkDash` |
| Branch | `extensions` (pushed to `origin`) |
| Base | `main` at `eb12925` — live disk read/write speed on remote Linux and Windows units |

`config/settings.json` and `docker-compose.yml` are dirty in the working tree and stay out of extension commits.

## Work

| Item | Status | Note |
| --- | --- | --- |
| Fork and remotes | done | `extensions` branch created locally |
| Design notes | done | `EXTENSIONS.md`, this file |
| Decode and prefill compare, multi-type run, history 30 | done | Compare pairs on model + prompt types (decode) or context sizes (prefill). Types walk in catalog order. History keeps 30, including the load-time slice |
| Quality history across ports | done | Page lists every stored run, shows the port, defaults to all ports, and can narrow to the port for the next run. On-disk `config/quality-bench-history.json` is root-owned mode 600; this user cannot read it, so there is no per-port count |
| Decode aggregate, sum, and overlap row | done | Stream, sum (streams × mean), and the stored aggregate. Overlap under 0.9 with TTFT spread of at least 100 ms says the streams did not overlap. Per-stream tFirst/tLast stay on the row |
| Tool-eval responsiveness label | done | Tile shows the score and median turn time when `median_turn_ms` is in the result. Tooltip states the existing curve |
| Overlay chart on the LLM panel | done | `LlmMetricOverlay` under the tok/s tiles in each `LlmPanel` (one ring per Spark and port). Overlay mode: decode `generationTps`, prefill `prefillTps`, and TTFT `ttftSeconds` when the probe publishes it. TTFT stays off until a real reading — vLLM while a request finishes in the poll, and FreeToken when `ttft_mean_ms` is present. Other engines leave `ttftSeconds` null, so that series is omitted. GPU history is unchanged |
| Playground | done | `/playground` is the llm-dashboard Playground (Lit), not the earlier rewrite. It uses the benchmark Spark picker, port, probe, API key, and SSH tunnel. Chat is a raw engine SSE relay. Generation defaults come from the engine documents and, for vLLM and SGLang, the live sampling metadata. The metric strip under the conversation is their chart behavior on a rewritten baseline. Generation throughput Mean is the arithmetic mean of non-zero samples from the first content token through the end of that reply, and it stays that mean when the reply ends. |
| Models page | done | `/models` follows the benchmark Spark. The server reads the controller bearer key from `MODEL_CONTROLLER_KEY_FILE` and calls port 29999, then the Unix socket over SSH if that port is closed. One switch per Spark; an unknown outcome blocks until acknowledged. The script panel hides start/stop for a matching managed workload, or for the whole list when a running managed model cannot be matched by port or name. |
| Agent page | done | `/agent` reaches OpenCode the way llm-dashboard does: the existing loopback tunnel at `http://127.0.0.1:14096` and `OPENCODE_CREDENTIALS_FILE` (mode 600). A fleet unit named uba is not required. Basic auth stays on the server. The iframe is `http(s)://<the dashboard page's hostname>:8093/` so OpenCode's router sees `/`. Port 8092 is llm-dashboard on this host. Health tries `/api/info`, then `/global/health`. |

## Next

The extension list in EXTENSIONS.md is implemented on this branch. `config/settings.json` and `docker-compose.yml` stay local and are not part of it.
