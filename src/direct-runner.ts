/**
 * Direct Runner — runs the agent-runner as a bun subprocess instead of Docker.
 *
 * Drop-in replacement for container-runner.ts when USE_CONTAINERS=false.
 * Spawns `bun run container/agent-runner/src/index.ts` with AGENT_WORKSPACE_DIR
 * pointing at the session workspace directory.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR, ONECLI_API_KEY, ONECLI_URL, TIMEZONE } from './config.js';
import { materializeContainerJson } from './container-config.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { initGroupFilesystem } from './group-init.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionDir,
  writeSessionRouting,
} from './session-manager.js';
import type { Session } from './types.js';

/** Active processes tracked by session ID. */
const activeProcesses = new Map<string, { process: ChildProcess; sessionId: string }>();

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeProcesses.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeProcesses.has(sessionId);
}

/**
 * Wake up a direct-runner process for a session. If already running or
 * mid-spawn, no-op (the in-flight wake promise is reused).
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeProcesses.has(session.id)) {
    log.debug('Direct runner already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Direct runner wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnDirectRunner(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer (direct) failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnDirectRunner(session: Session): Promise<void> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh destinations if the module is installed
  if (hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    writeDestinations(agentGroup.id, session.id);
  }
  writeSessionRouting(agentGroup.id, session.id);

  // Materialize container.json
  materializeContainerJson(agentGroup.id);

  // Ensure group filesystem exists
  initGroupFilesystem(agentGroup);

  // Compose CLAUDE.md fresh every spawn
  composeGroupClaudeMd(agentGroup);

  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // The workspace dir for the direct runner is the session dir itself.
  // The agent-runner expects:
  //   <workspace>/inbound.db
  //   <workspace>/outbound.db
  //   <workspace>/.heartbeat
  //   <workspace>/outbox/
  //   <workspace>/agent/  (group folder with CLAUDE.md, container.json)
  //
  // In container mode these are separate mounts; in direct mode we create
  // a symlink from <sessDir>/agent -> groupDir so the runner finds it.
  const agentSymlink = path.join(sessDir, 'agent');
  if (!fs.existsSync(agentSymlink)) {
    try {
      fs.symlinkSync(groupDir, agentSymlink);
    } catch (err) {
      // If the path exists as a directory already (from a prior run), skip
      if (!fs.existsSync(agentSymlink)) throw err;
    }
  }

  // Ensure outbox dir exists
  const outboxDir = path.join(sessDir, 'outbox');
  fs.mkdirSync(outboxDir, { recursive: true });

  // TODO: Symlink global memory at <sessDir>/global -> groups/global
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalSymlink = path.join(sessDir, 'global');
  if (fs.existsSync(globalDir) && !fs.existsSync(globalSymlink)) {
    try {
      fs.symlinkSync(globalDir, globalSymlink);
    } catch {
      // best-effort
    }
  }

  log.info('Spawning direct runner', { sessionId: session.id, agentGroup: agentGroup.name });

  // Clear any orphan heartbeat from a previous instance
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const entryPoint = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'index.ts');

  const proc = spawn('bun', ['run', entryPoint], {
    env: {
      ...process.env,
      AGENT_WORKSPACE_DIR: sessDir,
      TZ: TIMEZONE,
      ONECLI_URL: ONECLI_URL || '',
      ONECLI_API_KEY: ONECLI_API_KEY || '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeProcesses.set(session.id, { process: proc, sessionId: session.id });
  markContainerRunning(session.id);

  // Log stderr
  proc.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { directRunner: agentGroup.folder });
    }
  });

  // stdout is unused (all IO is via session DB)
  proc.stdout?.on('data', () => {});

  proc.on('close', (code) => {
    activeProcesses.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.info('Direct runner exited', { sessionId: session.id, code });
  });

  proc.on('error', (err) => {
    activeProcesses.delete(session.id);
    markContainerStopped(session.id);
    stopTypingRefresh(session.id);
    log.error('Direct runner spawn error', { sessionId: session.id, err });
  });
}

/** Kill a direct-runner process for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeProcesses.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.process.once('close', onExit);
  }

  log.info('Killing direct runner', { sessionId, reason });
  entry.process.kill('SIGTERM');

  // Force kill after 5s if still alive
  setTimeout(() => {
    if (activeProcesses.has(sessionId)) {
      entry.process.kill('SIGKILL');
    }
  }, 5000);
}

/**
 * Cleanup orphans — no-op for direct runner since processes are tracked
 * in-memory and die with the host process.
 */
export function cleanupOrphans(): void {
  // Nothing to do — bun subprocesses are children of this process
  // and get cleaned up when it exits.
}
