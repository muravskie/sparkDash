# Consolidation: dgx-spark-qwen38 retired

Written 2026-11-21 so work can continue from sparkDash after
`/home/fedor/code/dgx-spark-qwen38` is deleted. That directory was this note's
source checkout. Deleting it did not stop the model, the controller, sparkDash,
or llm-dashboard.

## Decision

The Qwen distribution checkout has finished its job as the model switchboard.
sparkDash is the operator interface. `spark-model-controller` owns container
lifecycle. The live Flash-Next recipe is `~/code/qwen38-flash-next-recipe`,
imported by the controller. Do not reopen a sparkDash branch to absorb the old
cockpit, installer, or `switch-model.sh`. Those were a second lifecycle writer.

Upstream of the retired repo is now `hasso5703/alzeo` (still fetched locally as
`origin` `hasso5703/dgx-spark-qwen38`). `origin/main` was v1.49.0 on 2026-11-15.
The local line stopped at v1.22.6 plus the controller-ownership commits. A full
merge is not a cleanup task: alzeo's installer and switcher can take lifecycle
back from the controller. The only upstream piece that matches "Flash-Next on
vLLM" is the separate FP4-Local lane (`install-flash-local.sh`,
`nvidia/Qwen3.8-Flash-Next-FP4-Local`, `eugr/spark-vllm-b12x` pinned 2026-10-20
and not moved since). That is a different checkpoint and image from the recipe
running here. Newer engine work outside alzeo was `blazux/qwen3.8-Flash-DGX`
(vLLM 0.33, 2026-11-04). Neither belongs in sparkDash.

## Deleted

`/home/fedor/code/dgx-spark-qwen38` is gone. Checked again the same day after the directory was removed. The model, controller, sparkDash, and llm-dashboard were still up.

Checked 2026-11-21 after the cockpit was disabled, and again after the directory was removed:

- `qwen38-dashboard.service` is inactive and disabled. Nothing listens on 30090 or 30091.
- The controller registry does not mount this tree. It mounts `~/code/qwen38-flash-next-recipe/cache` and `~/code/model-controller/scripts/flash-next-start.sh`.
- The running `qwen38-flash-next` container does not mount this tree.
- sparkDash mounts only `~/.config/qwen38/opencode-uba-service.json` from the Qwen config dir, not the git checkout.
- No service `ExecStart` still points at the checkout. The only processes with that directory as cwd were the Cursor session itself.

One untracked file is not on GitHub and will disappear with the directory:
`codex-session-01a0ee7f-8dcd-77e1-93a0-54a8ef80571b.md`. It was a session note, not a runtime input.

## Git record

Fork: https://github.com/muravskie/dgx-spark-qwen38 (public).

Branch `upgrade/v1.22.6` is on that fork at `8b1b817` (2026-10-04), tracking
`fork/upgrade/v1.22.6`. The three commits that existed only on this machine, now
pushed, are:

- `a461054` Preserve controller and remote OpenCode cockpit integrations before upgrade
- `9bbf8dd` Merge v1.22.6 while preserving controller ownership and remote OpenCode
- `8b1b817` Fix installer isolation and update cockpit documentation contracts

`a461054` contains the Uba tunnel installer and a LAN address in `docs/cockpit.md`.
The fork also still has `main` (`3aeaed0`, 2026-09-19) and `dashboard-throughput`
(`1cb3122`, 2026-09-25).

## What stays

| Path or unit | Role |
|---|---|
| `~/code/sparkDash` | Dashboard. UI on `:5555`. Agent on `:8093`, upstream default `127.0.0.1:14096`. Container name `sparkDash`, host network. |
| `~/code/model-controller` | Lifecycle. Socket `/run/spark-model-controller/controller.sock`. LAN API `192.168.1.64:29999`. Installed registry `/etc/spark-model-controller/models.yaml`. |
| `~/code/qwen38-flash-next-recipe` | Live Flash-Next recipe (`recipe.yaml`, `run.sh`). Container `qwen38-flash-next` on `:8000`. |
| `~/.config/qwen38/` | Host state. Keep it. Holds `opencode-uba-service.json` (sparkDash Agent credentials), `controller-managed`, the API key, and the deployed `keepalive-proxy.py`. |

## Still running, not part of the checkout

`qwen38-keepalive.service` was stopped and disabled on 2026-11-21. Nothing
listens on `:30001`. The proxy file remains at
`~/.config/qwen38/keepalive-proxy.py`. Its old upstream was port 30000.

`qwen38-sglang.service` was inactive. It starts a Docker container by name and
does not need the git checkout. Leave it disabled.

`~/.local/bin/oc` is an opencode wrapper installed by the old repo. It does not
read the checkout. A comment names the repo. Harmless to leave.

## Ports on this host (2026-11-21)

| Port | What |
|---|---|
| 5555 | sparkDash |
| 8093 | sparkDash Agent, same Uba tunnel the old cockpit relayed |
| 14096 | Uba OpenCode tunnel on loopback |
| 8090 / 8092 | llm-dashboard, stopped and disabled 2026-11-21 |
| 8000 | `qwen38-flash-next` |
| 29999 | model controller API |
| 30001 | keepalive proxy, stopped and disabled 2026-11-21 |
| 30090 / 30091 | old cockpit, gone |

## Continue from here

The checkout is gone. Do not restore it to operate this host.

Recipe and lifecycle changes go in `qwen38-flash-next-recipe` and
`model-controller`, then a controller registry reload. sparkDash stays a
dashboard synced with Mia's tip.

`llm-dashboard` was stopped and disabled on 2026-11-21, and `/home/fedor/code/llm-dashboard` is gone. Nothing listens on 8090 or 8092. The pushed tip remains `fc59785` on `muravskie/llm-dashboard`. The uncommitted playground edits in that checkout were the work already running in sparkDash.

The TensorFold start script now lives at `~/code/model-controller/scripts/tensorfold-start.sh`. Both the source registry and `/etc/spark-model-controller/models.yaml` mount that path. The running model is still `qwen38-flash-next`, which does not use that script.

`model-controller` `STATE.md` no longer says the Stark Cockpit is serving port 30090.
