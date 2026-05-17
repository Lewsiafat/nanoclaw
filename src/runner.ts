/**
 * Runner dispatcher.
 *
 * One switch point for "Docker container vs. direct bun subprocess". Reads
 * USE_CONTAINERS once at module load and re-exports the matching set of
 * functions. Call sites import from here instead of container-runner.ts so
 * USE_CONTAINERS=false truly removes Docker from the runtime path (not just
 * from startup).
 *
 * buildAgentGroupImage is container-only and lives on container-runner.ts;
 * its callers (groups CLI, self-mod) import it directly and only invoke it
 * when the user asks to rebuild — those paths are inherently Docker-bound.
 */
import * as container from './container-runner.js';
import * as direct from './direct-runner.js';

const USE_CONTAINERS = process.env.USE_CONTAINERS !== 'false';
const impl = USE_CONTAINERS ? container : direct;

export const wakeContainer = impl.wakeContainer;
export const killContainer = impl.killContainer;
export const isContainerRunning = impl.isContainerRunning;
