# OpenCode Go — Lessons Learned

## 1. What OpenCode Go is and isn't

- **OpenCode Go** ($10/month) gives a direct OpenAI-compatible API to 32+ models at
  `https://opencode.ai/inference/go/v1`, authenticated with the console OAuth token
  (key: `opencode-go-console` in `~/.pi/agent/auth.json`).
- **The free Nemotron (Zen) is NOT on Go.** Zen at `https://opencode.ai/zen/v1`
  returns 403 `FreeTierError` for any direct API call (curl, aider, tool-eval).
  The gate is on the *client*, not the credential — only the `opencode` binary
  passes it. tool-eval and Aider cannot target the free Nemotron.
- The 32 Go models include a few free ones (Cat Jam Free, Step 5 Preview,
  LongCat 2.5 Preview Free) and paid ones (GLM-5.3, Grok 4.7, Qwen3.8
  Flash/Max, Kimi K3, DeepSeek V4, MiniMax M3, etc.).

## 2. The required headers

Go refuses raw `curl`/aider/tool-eval traffic. Every request must include:

- `Authorization: Bearer <console access token>` — the tool sends this if
  `OPENAI_API_KEY` is set
- `x-opencode-session: <stable id>` — **required**, 400 `MissingSessionID` without it
- A **non-generic User-Agent** like `my-coding-agent/1.0` (Go monitors for abuse)

Validated clients (send their own session headers): OpenCode, Claude Code, Codex,
Hermes, Pi, jcode, Kilo Code CLI. **Not validated**: tool-eval, aider, raw curl.

## 3. The proxy

`opencode-run/go-proxy.py` is a ~150-line Python proxy on `127.0.0.1:8787`. It:

- Injects `x-opencode-session` and a custom `User-Agent`
- Forwards `Authorization` from the client
- Streams responses with chunked transfer encoding

**Critical: always re-chunk the response.** First version had a bug where it
added `Transfer-Encoding: chunked` only when the upstream wasn't already chunked.
For upstream-chunked (SSE) responses it stripped the header and didn't replace
it, so the client saw raw chunk-length bytes in the body. The fix: ALWAYS add
`Transfer-Encoding: chunked` to the client, always drop upstream CL/TE.
Aider's streaming path depends on this.

**Upstream timeout: 300s.** The Go gateway can queue/throttle a request for
20+ minutes before Cloudflare times out with a 524. Catching it at 300s
saves ~17 minutes per throttled request and surfaces the rate limit quickly.

## 4. Run the proxy as a systemd unit

`~/.config/systemd/user/go-proxy.service` — survives independently of the
benchmark run. Started via `go-proxy-service.sh` which reads the token
from `~/.pi/agent/auth.json` (so the token isn't baked into the unit file).
With `Restart=always`, the proxy auto-restarts on crash. **Critical**: a
background-shell proxy dies when the shell session ends; systemd doesn't.

## 5. The rate-limit problem and the monitor

**Symptoms of Go rate limiting** (verified):
- Requests hang for hundreds of seconds
- Some return 524 (Cloudflare) after ~1200s with `upstream_cl=95` (tiny error page)
- **No `429` or rate-limit headers** — Go doesn't signal throttling explicitly,
  it just sits on the request

**The monitor** in `go-bench-aider-only.sh` (and `smoke-medium.sh`) checks
three triggers every 10s and kills the Aider process if any fires:

1. **RL signals** — `≥2` entries in `/tmp/opencode/go-rate-limit` (the proxy
   writes a timestamp on each timeout/error) within a 300s window
2. **Proxy dead** — port 8787 not listening (`ss -ltn | grep :8787`)
3. **Connection error in Aider log** — Aider's litellm raises this when the
   proxy socket is gone (the previous run's r2-r4 all-zero was this case)

Without (2) and (3), the monitor only catches timeouts, not a dead proxy.

## 6. Concurrency: c4 not c8 on Go

The Go gateway throttles under sustained load. At **c8**, xhigh on the
first rep already degraded (10/30 vs 27/30 for an earlier run). At **c4**,
all 4 arms complete cleanly. The probe is 30 tasks; c4 ≈ 3-5 min/arm.
Use c4 as the default. C8 is risky for xhigh.

## 7. Probe uses 2 tries; screen uses 1. Big difference.

- `Aider probe (2 tries, c8)`: pass_final 23-28/30 on qwen3.8-flash
- `Aider screen (1 try, c4)`: pass_1 29-41/83 on qwen3.8-flash

The probe→screen drop is dominated by the **retry mechanism**, not rate
limits. On the vLLM baseline, probe pass_1 was 27%, pass_final 70% (43pp
retry rescue). On qwen3.8-flash, probe pass_1 was ~20%, pass_final 77%
(57pp rescue). Screen at 1 try misses this rescue.

**Don't compare probe to screen directly** — the retry confound makes
the drop look like model degradation. Compare 1-try to 1-try (probe
pass_1 vs screen) or 2-try to 2-try (probe pass_final vs full set).

The screen is no longer maintained by the suite and is being abandoned.
For hosted-model benchmarks, run **probe (2 tries) + full set (2 tries)**.

## 8. Per-request accounting was wrong, the fix

- The `Aider benchmark.py` writes `.aider.results.json` per task with an
  `outcome` field: `pass_1`, `pass_retry`, `wrong`, `infra`, `no_answer`,
  etc.
- **The dedup key is `(lang, task)`** — `javascript/bowling` and
  `python/bowling` are different tasks. Using just `task` collapses them.
- **Old run dirs contaminate counts.** Every rerun leaves a timestamped
  dir under `aider-run/aider/tmp.benchmarks/`. A glob picks up all of them.
  `opencode-run/go-report.py` picks the **newest per arm** explicitly.
- **The wrapper's `rm -rf` of prior dirs before each arm** is the right
  thing to do *only after* you've confirmed the previous run is done
  and you've captured results. Don't auto-delete before confirmation.
- tool-eval results.json's score is at `final_score` (0-100), NOT
  `scenarios[].points` (that key doesn't exist in this version).

## 9. The harness is now validated

Smoke test (medium r1 probe, c4, 2 tries): **28/30 pass**, 0 × 504, 0 proxy
deaths, 0 monitor kills. The rerun reproduces the earlier single-rep
result, so the harness is reliable enough to launch the full 4-rep × 4-arm
probe matrix.

## 10. Pre-existing bug: proxy log was overwritten

The proxy used to write to a single log file. Restarting the proxy
overwrote the log, losing the 524 evidence from the earlier run.
**Future fix: rotate the proxy log** (e.g., append-timestamped files or a
proper logrotate config). For now, `cp` the log before restarting.

## 11. What "the same model" means

`qwen3.8-flash` (Go) vs `Qwen3.8-Flash-Next` (local, 27B NVFP4) read like
the same model, but the names are different and we couldn't confirm the
weights are the same. The hosted probe (28/30) is ~7pp better than the
local vLLM probe (21/30), but that's within 1 SD of the 2.3-task noise for
a single run. To answer "is it the quant?" cleanly, you'd need to run
the *same* weights through both paths.
