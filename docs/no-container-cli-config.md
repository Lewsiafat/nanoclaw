# No-Container Mode + Config CLI

> Branch: `feature/no-container-cli-config`
> Status: Wired end-to-end (was prototype-only on the initial commit; fully connected as of commit `01dc7f6`)

## Goal

Make NanoClaw **easy to install** (no Docker required) and **easy to configure** (no `.env` editing). Keep the surface minimal — one runtime flag, one config file, one CLI command.

---

## Walkthrough — From zero to first message

### 0. Prerequisites

```bash
# Required
node --version    # >= 20
pnpm --version    # >= 9
bun --version     # >= 1.1  — direct mode spawns the agent-runner as a bun process

# Optional (only if you also want container mode)
docker --version
```

If you don't have bun: `curl -fsSL https://bun.sh/install | bash`.

### 1. Clone and install

```bash
git clone https://github.com/Lewsiafat/nanoclaw
cd nanoclaw
git checkout feature/no-container-cli-config
pnpm install
cd container/agent-runner && bun install && cd -
pnpm run build
```

### 2. Configure via CLI (no `.env` editing needed)

The CLI server runs alongside the host. Boot the host once so the socket
is alive, then in another terminal:

```bash
# In terminal A — start the host (it'll come up with defaults)
USE_CONTAINERS=false pnpm run dev

# In terminal B — set your config
pnpm exec ncl config set --key ASSISTANT_NAME --value Leo
pnpm exec ncl config set --key TZ --value Asia/Taipei
pnpm exec ncl config set --key ONECLI_URL --value http://localhost:10254
pnpm exec ncl config set --key ONECLI_API_KEY --value <your-key>

pnpm exec ncl config show
```

Values land in `~/.config/nanoclaw/config.json` immediately, but the
host reads them at module load — restart the host (Ctrl+C in terminal A,
then re-run) for new values to take effect.

### 3. Wire a channel

Pick any channel skill, e.g. `/add-telegram`, and follow its setup. The
channel adapter doesn't care about container vs. direct mode — it lands
messages on the central DB exactly the same way.

### 4. First message

Send a message to the wired channel. The host's router resolves the
session, writes to `inbound.db`, and calls `wakeContainer(session)`.

- In **direct mode** (`USE_CONTAINERS=false`): `runner.ts` dispatches to
  `direct-runner.wakeContainer`, which spawns `bun run container/agent-runner/src/index.ts`
  with `AGENT_WORKSPACE_DIR=<session dir>`.
- In **container mode** (`USE_CONTAINERS=true`, or unset): same call
  reaches `container-runner.wakeContainer` and starts a Docker container.

The agent-runner reads `${AGENT_WORKSPACE_DIR}/inbound.db`, calls Claude,
writes to `outbound.db`, and the host delivers back through the adapter.

---

## Spec

### Runtime mode — `USE_CONTAINERS`

| Value | Behaviour |
|-------|-----------|
| `false` (default) | Agent-runner spawned as a direct `bun` subprocess. No Docker required. |
| `true` (or unset in legacy setups — see note) | Original Docker container behaviour. |

**Default:** the branch ships with `USE_CONTAINERS !== 'false'` semantics
(`src/index.ts:18`). Set the env var explicitly to opt out.

**Dispatch layer:** `src/runner.ts` reads the flag once at module load
and re-exports `wakeContainer` / `killContainer` / `isContainerRunning`
from the matching backend. Every call site (router, host-sweep,
container-restart, approvals primitive, groups CLI, self-mod) imports
from `./runner.js` — flipping the flag actually flips the runtime path.

`buildAgentGroupImage` stays on `container-runner.ts` because it's
inherently Docker-bound; the two paths that call it (groups CLI rebuild
and self-mod `install_packages`) only fire on explicit user action.

### Config file — `~/.config/nanoclaw/config.json`

| Key | Default | Effect |
|-----|---------|--------|
| `ASSISTANT_NAME` | `Andy` | Agent display name + default trigger (`@<name>`) |
| `TZ` | system tz → `UTC` | IANA timezone for scheduling and formatting |
| `ONECLI_URL` | *(empty)* | OneCLI Agent Vault base URL |
| `ONECLI_API_KEY` | *(empty)* | OneCLI API key (masked in `ncl config show`) |
| `CONTAINER_TIMEOUT` | `1800000` | Session timeout in ms |
| `MAX_CONCURRENT_AGENTS` | `5` | Max concurrent agent sessions (alias for the internal `MAX_CONCURRENT_CONTAINERS`) |

**Precedence (highest → lowest):**

```
process.env > .env > ~/.config/nanoclaw/config.json > built-in default
```

A value set via `ncl config set` only matters if neither `process.env`
nor `.env` already set the same key. This matches existing user
expectations — env vars stay authoritative for production deployments.

### CLI — `ncl config`

```
ncl config show              # table of all keys + values + sources
ncl config get --key <K>     # single key
ncl config set --key <K> --value <V>
ncl config reset --key <K>   # remove from config.json → falls back to default
```

Numeric keys (`CONTAINER_TIMEOUT`, `MAX_CONCURRENT_AGENTS`) are coerced
from string at write time. Unknown keys are rejected.

---

## What changed (vs. trunk)

```
docs/no-container-cli-config.md       (this file)
src/cli/resources/config.ts            (new) — ncl config show/get/set/reset
src/cli/resources/index.ts             (+1)  — barrel import
src/config.ts                          (+22) — JSON layer + MAX_CONCURRENT_AGENTS alias
src/direct-runner.ts                   (new) — bun-subprocess equivalent of container-runner
src/runner.ts                          (new) — dispatcher: container-runner | direct-runner
src/index.ts                           (+6)  — gate Docker startup behind USE_CONTAINERS
src/router.ts                          (~1)  — wakeContainer from runner.js
src/host-sweep.ts                      (~1)  — wake/kill/isRunning from runner.js
src/container-restart.ts               (~1)  — wake/kill/isRunning from runner.js
src/modules/approvals/primitive.ts     (~1)  — wakeContainer from runner.js
src/cli/resources/groups.ts            (~1)  — kill/wake from runner.js
src/modules/self-mod/apply.ts          (~1)  — kill/wake from runner.js
container/agent-runner/src/{config,index,db/connection,cli/ncl,mcp-tools/core,providers/claude,formatter}.ts
                                              — replace hardcoded /workspace/* with AGENT_WORKSPACE_DIR
```

---

## Verification

- `pnpm run build` — TypeScript clean
- `pnpm test --run` — 326/326 host tests pass
- `USE_CONTAINERS=false` → `runner.wakeContainer === direct-runner.wakeContainer`
- `USE_CONTAINERS=true` → `runner.wakeContainer === container-runner.wakeContainer`
- `ncl config set --key ASSISTANT_NAME --value Leo` → next host start resolves `ASSISTANT_NAME='Leo'`

---

## Known limitations

These are intentionally out of scope for the "easy install" goal — pick
them up when there's a concrete use case.

- **No process isolation** in direct mode — the agent-runner runs as the
  host user. Don't expose direct mode to untrusted senders.
- **No resource limits** — Docker provided CPU/memory ceilings; direct
  mode inherits host limits.
- **`cleanupOrphans()` in direct mode is in-memory only** — children of a
  prior host process aren't tracked. They'll exit on their own (no input
  arrives, container-runner-style heartbeat sweep still applies via
  host-sweep) but won't be force-killed across host restarts.
- **OneCLI vault in direct mode untested end-to-end.** `ONECLI_URL` /
  `ONECLI_API_KEY` are forwarded to the spawned bun process, but
  per-request secret injection (which depends on OneCLI's HTTP proxy +
  CA cert) hasn't been validated in this mode.
- **`additionalMounts` not implemented in direct mode** — see TODO in
  `src/direct-runner.ts`. Container mode handles this via Docker `-v`.
- **`ncl config show` source label** marks a value from `.env` as
  `default`. Cosmetic only; the resolved value is still correct.
