# sparkDash extensions

This fork is the place where sparkDash grows the bench, chat, and model-lifecycle tools that already exist beside it. Upstream stays [MiaAI-Lab/sparkDash](https://github.com/MiaAI-Lab/sparkDash). This checkout tracks that repo as `upstream` and pushes to [muravskie/sparkDash](https://github.com/muravskie/sparkDash) as `origin`. Day-to-day work is on the `extensions` branch.

The goal is one interface for the fleet. Monitoring, benchmarks, a chat playground, the OpenCode agent, live charts, and model switching all live in sparkDash. llm-dashboard and model-controller stay the sources of behavior. They are not replaced as services on the Spark; their screens move here.

New screens and servers go in new directories. Existing sparkDash files change only where a route, a sidebar entry, or a benchmark job has to know about the new behavior. That keeps a later merge from `upstream/main` small.

`config/settings.json` and `docker-compose.yml` in this working tree are local deployment edits. They are not part of the extension.

## Where new code goes

| Path | Role |
| --- | --- |
| `src/components/playground/` | Multi-turn chat page |
| `src/components/agent/` | OpenCode embed |
| `src/components/models/` | Controller lifecycle page |
| `src/components/charts/MetricOverlayChart.tsx` | Time series with a distribution histogram |
| `server/playground/` | Chat relay onto a probed LLM |
| `server/agent/` | OpenCode proxy |
| `server/models/` | Controller proxy |

Routes are registered in `src/constants.ts`: `/playground`, `/agent`, `/models`. The sidebar and the mobile tab bar each gain one link per page. Decode, prefill, quality, and tool-eval stay on their current pages.

Showcase stays the scripted multi-terminal demo. The Spark-page Models panel stays the `start.sh` / `stop.sh` launcher for folders the controller does not own.

## Benchmarks

### Compare runs

Decode and prefill history gain the Compare action quality and tool-eval already have. Two runs open side by side when they share a setup: same model and prompt type for decode, same context sizes for prefill. Decode shows aggregate tok/s and stream tok/s at each concurrency, with a delta. Prefill has one measured rate per context size, so that table is prefill tok/s and a delta. A mismatched pair shows why it cannot be paired, and does not invent a score.

Decode and prefill history grow from the last 10 runs to the last 30, matching quality, so there is a list worth comparing.

### Quality history

Quality already stores 30 runs. The page lists every stored run for the Spark, with the port on each row, and can filter to the port selected for the next run. Runs on another port stay visible instead of disappearing behind that filter.

### Decode: several types, one run

The Structured, Prose, Code, and JSON controls become selectors, the same way concurrency levels already are. All types is a selector preset. Run starts one job that walks the selected types in order, and for each type walks the selected concurrency levels. Results are grouped by type, then by concurrency. The history line names the types in the job.

Concurrency stays whatever is selected. The job does not turn on every concurrency level by itself.

### Decode aggregate and stream

Each result row shows three rates:

- **Stream** is the average of each stream's own tok/s, measured from its first content token to its last.
- **Sum** is that average times the number of streams that produced tokens. It is the rates added up, not a claim that they happened at the same instant.
- **Aggregate** is every decode token from those streams divided by one shared clock, from the earliest first token to the latest last token. That is the wall-clock throughput of the wave.

Overlap is aggregate divided by sum. The row says when the streams did not overlap, which is when time-to-first-token spreads out while each stream's own rate stays high. Per-stream start and end stay available on the row. The stored aggregate formula stays as it is.

### Tool-eval Responsiveness

Responsiveness is a 0–100 score of median turn latency, not generation speed. tool-eval-bench maps the median wall-clock time of a scenario turn through `100 / (1 + (median_turn_ms / 3000) ^ 1.5)`. A turn is one request: prefill, any thinking, and the answer. The tile shows the score and the median turn time, and the tooltip states that curve. About 84 is a 1 second turn, 50 is 3 seconds, 32 is 5 seconds. Two models can have the same tok/s and different responsiveness when one spends more time per turn.

## Playground

The `/playground` page is the llm-dashboard Playground, mounted here and relayed through sparkDash. The server uses the same probe, API key, and SSH tunnel as decode, and pipes the engine event stream back to that page. The page supports:

- multi-turn replies, including reasoning text
- tool-call deltas, with tool results typed in by hand
- temperature, top p, top k, max tokens, presence penalty, thinking, reasoning effort, and a thinking budget, with the engine's reported default under each input
- presets stored in the browser
- import and export of the conversation as JSON
- stop, which closes the upstream request
- a replay batch at a chosen concurrency

Sampling defaults come from the engine when it reports them. Controls without a reported default stay blank.

The chat stream parser is written for this server. The Tandem stream reader is not imported.

## Agent

`/agent` embeds OpenCode the way llm-dashboard reaches it: the existing loopback SSH tunnel on this host and a server-side credentials file. The page is an iframe at `http(s)://<the dashboard page's hostname>:8093/`, so OpenCode's router sees `/`. sparkDash's server proxies to that loopback upstream and adds basic auth from the credentials file. The browser session is the dashboard's existing login, and the browser cannot supply the upstream URL. A fleet unit named uba is not required. The relay follows the behavior of the MIT Cockpit agent relay.

## Models

`/models` is the model-controller screen from llm-dashboard's Models tab, for the Spark selected on the page. The controller is per machine, so the page follows the selected Spark.

Each row is a registry model or an explicit external monitor: name, endpoint, roles, engine, ownership, runtime, and health. Activate and Deactivate ask for confirmation. External rows are monitoring only. The page lists dashboard operations and asks for an acknowledgement when an outcome is unknown. It also lists recent controller journal events: model, operation, phase, transaction id.

The sparkDash server calls that Spark's controller. The bearer key is read from a file on the server and is never sent to the browser or written into `sparks.json`. The first path is the controller's HTTP listener on port 29999. If that port is not reachable from the dashboard host, the server uses SSH and the controller's Unix socket. Only one switch runs at a time. A new switch waits while the controller journal still has an unfinished transaction. A Spark with no controller shows an empty state.

The Spark-page script launcher does not grow Activate buttons. When the controller reports a managed model on that Spark, the script panel does not offer start or stop for that workload.

## Charts

`MetricOverlayChart` is a React chart with the same behavior as the llm-dashboard metric chart. The geometry is new code: a linear scale and a monotone curve written here, not copied from Tandem.

- A line of samples across a time window. A gap in the line opens when the interval between samples is more than three times the median interval, and at least 15 seconds.
- Overlay mode draws a 16-bin histogram of the values in the window behind that line. The bin that holds the mean is highlighted. A dashed line marks the mean. Sample counts sit on the right axis. Time sits on the top axis.
- Hovering or using the arrow keys moves a crosshair and reads the value.
- Trend-only and histogram-only are the other two modes. The Spark LLM panel uses overlay.

Samples are the generation tok/s, prefill tok/s, and TTFT the LLM probe already collects. A short ring buffer next to the chart holds them. The GPU history chart is unchanged. The widget sits on the Spark LLM panel under the tok/s tiles.

## Order

1. Decode and prefill comparison, the multi-type decode job, the longer history, the aggregate row, and the responsiveness label.
2. Quality history across ports.
3. The overlay chart on the LLM panel.
4. Playground.
5. Models page and the script-panel guard for controller-owned workloads.
6. Agent page for OpenCode on uba.
