# No-Container Mode + Config CLI

> Branch: `feature/no-container-cli-config`
> Date: 2026-05-17
> Status: Prototype / Test

## Overview

This branch implements two features for running NanoClaw without Docker:

1. **No-Container Mode** — replace Docker container spawning with a direct `bun` subprocess
2. **Config CLI** — `ncl config` commands backed by `~/.config/nanoclaw/config.json`

---

## Feature 1: No-Container Mode

### What Changed

NanoClaw originally ran every agent session inside a Docker container. This removes that requirement — the agent-runner is spawned as a direct `bun` subprocess instead.

#### Environment Flag

```bash
USE_CONTAINERS=false   # default — run agent directly via bun
USE_CONTAINERS=true    # restore original Docker behaviour
```

#### Files Modified

| File | Change |
|------|--------|
| `container/agent-runner/src/config.ts` | Export `WORKSPACE_DIR` constant; read from `AGENT_WORKSPACE_DIR` env var (default: `/workspace` for Docker compat) |
| `container/agent-runner/src/index.ts` | Replace hardcoded `CWD = '/workspace/agent'` with `${WORKSPACE_DIR}/agent` |
| `container/agent-runner/src/db/connection.ts` | Replace hardcoded inbound/outbound/heartbeat paths with `AGENT_WORKSPACE_DIR` |
| `container/agent-runner/src/cli/ncl.ts` | Replace hardcoded DB paths with `AGENT_WORKSPACE_DIR` |
| `container/agent-runner/src/mcp-tools/core.ts` | Replace hardcoded `/workspace/agent` and `/workspace/outbox` paths |
| `container/agent-runner/src/providers/claude.ts` | Replace hardcoded `/workspace/agent/conversations` path |
| `container/agent-runner/src/formatter.ts` | Replace hardcoded `/workspace/${a.localPath}` with env var |
| `src/direct-runner.ts` | **New** — drop-in replacement for `container-runner.ts` |
| `src/index.ts` | Gate `ensureContainerRuntimeRunning` + `cleanupOrphans` behind `USE_CONTAINERS` flag |
| `src/config.ts` | Add comments noting container image vars are no-ops in direct mode |

#### New File: `src/direct-runner.ts`

Exports the same interface as `container-runner.ts`:

```ts
wakeContainer(session: Session): Promise<boolean>
killContainer(sessionId: string): Promise<void>
cleanupOrphans(): Promise<void>
getActiveContainerCount(): number
isContainerRunning(sessionId: string): boolean
```

**How it works:**

1. Creates a per-session workspace directory at `data/v2-sessions/{agentGroupId}/{sessionId}/workspace/`
2. Writes `container.json` to `workspace/agent/container.json` (same format as Docker version)
3. Symlinks group folder → `workspace/agent/` and global memory → `workspace/global/`
4. Spawns: `bun run container/agent-runner/src/index.ts`
5. Sets env vars:
   - `AGENT_WORKSPACE_DIR` → session workspace path
   - `TZ` → timezone from config
   - `ONECLI_URL` + `ONECLI_API_KEY` → from host config
6. Monitors process exit, cleans up on SIGTERM (5s SIGKILL fallback)

**Workspace directory structure (per session):**

```
data/v2-sessions/{agentGroupId}/{sessionId}/workspace/
├── agent/              ← symlink → groups/{groupName}/
│   ├── CLAUDE.md
│   ├── container.json  ← written by direct-runner
│   └── ...
├── global/             ← symlink → groups/global/
├── inbound.db          ← host-owned (messages in)
├── outbound.db         ← agent-owned (messages out)
├── .heartbeat
└── outbox/
```

### How to Run (No Docker)

**Prerequisites:**
- `bun` installed globally (`curl -fsSL https://bun.sh/install | bash`)
- All other NanoClaw dependencies (`pnpm install`)

**Start NanoClaw without Docker:**

```bash
# Default (no containers)
npm run dev

# Explicitly set flag
USE_CONTAINERS=false npm run dev

# Restore Docker mode
USE_CONTAINERS=true npm run dev
```

### Known Limitations (TODOs)

- Container isolation is removed — agent processes run with host user permissions
- No resource limits (CPU/memory) unlike Docker containers
- `cleanupOrphans()` only cleans up processes from the current run (no cross-restart tracking)
- OneCLI Agent Vault integration not tested in direct mode
- Additional mounts (`containerConfig.additionalMounts`) not implemented — marked with `TODO:` in code

---

## Feature 2: Config CLI (`ncl config`)

### Config File Location

```
~/.config/nanoclaw/config.json
```

Created automatically on first `ncl config set`.

### Supported Keys

| Key | Description | Default |
|-----|-------------|---------|
| `ASSISTANT_NAME` | Agent display name | `Andy` |
| `TZ` | Timezone (IANA format) | `UTC` |
| `ONECLI_URL` | OneCLI server URL | *(empty)* |
| `ONECLI_API_KEY` | OneCLI API key *(masked in display)* | *(empty)* |
| `CONTAINER_TIMEOUT` | Session timeout in ms | `1800000` |
| `MAX_CONCURRENT_AGENTS` | Max concurrent agent sessions | `5` |

### Commands

#### `ncl config show`

Print all config keys as a formatted table showing value, default, and source.

```
$ ncl config show

Key                    Value              Default    Source
─────────────────────────────────────────────────────────
ASSISTANT_NAME         Leo                Andy       config
TZ                     Asia/Taipei        UTC        config
ONECLI_URL             http://localhost…  (empty)    config
ONECLI_API_KEY         sk-o...key4        (empty)    config  [secret]
CONTAINER_TIMEOUT      1800000            1800000    default
MAX_CONCURRENT_AGENTS  5                  5          default
```

#### `ncl config get`

Get a single key's value.

```bash
ncl config get --key ASSISTANT_NAME
# → Leo
```

#### `ncl config set`

Write a value to the config file.

```bash
ncl config set --key ASSISTANT_NAME --value Leo
ncl config set --key TZ --value Asia/Taipei
ncl config set --key ONECLI_API_KEY --value sk-or-v1-xxxxx
ncl config set --key MAX_CONCURRENT_AGENTS --value 10
```

Numeric values are automatically coerced from strings.

#### `ncl config reset`

Remove a key from the config file (reverts to built-in default).

```bash
ncl config reset --key ASSISTANT_NAME
# → ASSISTANT_NAME reset to default (Andy)
```

### Config File Format

```json
{
  "ASSISTANT_NAME": "Leo",
  "TZ": "Asia/Taipei",
  "ONECLI_URL": "http://localhost:8080",
  "ONECLI_API_KEY": "sk-or-v1-xxxxx",
  "MAX_CONCURRENT_AGENTS": 10
}
```

### New Files

| File | Purpose |
|------|---------|
| `src/cli/resources/config.ts` | Registers `config show/get/set/reset` commands |
| `src/cli/resources/index.ts` | Imports `config.ts` barrel (modified) |

---

## Quick Start (Both Features Together)

```bash
# 1. Clone and install
git clone https://github.com/Lewsiafat/nanoclaw
cd nanoclaw
git checkout feature/no-container-cli-config
pnpm install

# 2. Configure via CLI (no .env editing needed)
npx tsx src/cli/client.ts config set --key ASSISTANT_NAME --value MyBot
npx tsx src/cli/client.ts config set --key TZ --value Asia/Taipei
npx tsx src/cli/client.ts config set --key ONECLI_URL --value http://localhost:8080
npx tsx src/cli/client.ts config set --key ONECLI_API_KEY --value sk-or-v1-xxxxx

# 3. Start (no Docker required)
npm run dev

# 4. Check config anytime
npx tsx src/cli/client.ts config show
```

---

## Comparison: Container vs Direct Mode

| Aspect | Container Mode (original) | Direct Mode (this branch) |
|--------|--------------------------|--------------------------|
| Runtime | Docker | bun |
| Isolation | Full OS-level container | Process-level only |
| Setup | Docker Desktop required | bun required |
| Resource limits | Docker limits (CPU/mem) | None (host limits) |
| Security | OneCLI Agent Vault | Same (Vault untested) |
| Speed | Slower (container start ~2s) | Faster (process start ~200ms) |
| Windows support | Needs Docker Desktop | Native (if bun installed) |
| Production readiness | ✅ | ⚠️ Prototype |

---

## Files Changed Summary

```
12 files changed, 428 insertions(+), 22 deletions(-)

Modified:
  container/agent-runner/src/cli/ncl.ts
  container/agent-runner/src/config.ts
  container/agent-runner/src/db/connection.ts
  container/agent-runner/src/formatter.ts
  container/agent-runner/src/index.ts
  container/agent-runner/src/mcp-tools/core.ts
  container/agent-runner/src/providers/claude.ts
  src/cli/resources/index.ts
  src/config.ts
  src/index.ts

New:
  src/cli/resources/config.ts   (+176 lines)
  src/direct-runner.ts          (+213 lines)
```
