/**
 * CLI config resource — `ncl config show|get|set|reset`
 *
 * Reads/writes ~/.config/nanoclaw/config.json for host-level configuration.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { register } from '../registry.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'nanoclaw');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

interface ConfigSchema {
  ASSISTANT_NAME?: string;
  TZ?: string;
  ONECLI_URL?: string;
  ONECLI_API_KEY?: string;
  CONTAINER_TIMEOUT?: number;
  MAX_CONCURRENT_AGENTS?: number;
}

const CONFIG_KEYS: Record<keyof ConfigSchema, { description: string; default: string | number; secret?: boolean }> = {
  ASSISTANT_NAME: { description: 'Agent display name', default: 'Andy' },
  TZ: { description: 'Timezone (IANA format, e.g. Asia/Taipei)', default: 'UTC' },
  ONECLI_URL: { description: 'OneCLI server URL', default: '' },
  ONECLI_API_KEY: { description: 'OneCLI API key', default: '', secret: true },
  CONTAINER_TIMEOUT: { description: 'Session timeout in ms', default: 1800000 },
  MAX_CONCURRENT_AGENTS: { description: 'Max concurrent agent sessions', default: 5 },
};

function readConfig(): ConfigSchema {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw) as ConfigSchema;
  } catch {
    return {};
  }
}

function writeConfig(config: ConfigSchema): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
}

function maskSecret(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '...' + value.slice(-4);
}

// --- ncl config show ---
register({
  name: 'config show',
  description: 'Show all config values as a formatted table.',
  access: 'open',
  parseArgs: () => ({}),
  handler: async () => {
    const config = readConfig();
    const rows: Record<string, { value: string; default: string; source: string }> = {};

    for (const [key, meta] of Object.entries(CONFIG_KEYS)) {
      const k = key as keyof ConfigSchema;
      const rawValue = config[k];
      const hasValue = rawValue !== undefined;
      let displayValue: string;

      if (hasValue) {
        displayValue = meta.secret ? maskSecret(String(rawValue)) : String(rawValue);
      } else {
        displayValue = String(meta.default) || '(empty)';
      }

      rows[key] = {
        value: displayValue,
        default: String(meta.default) || '(empty)',
        source: hasValue ? 'config' : 'default',
      };
    }

    return { file: CONFIG_FILE, values: rows };
  },
});

// --- ncl config get <key> ---
register({
  name: 'config get',
  description: 'Get a single config value. Use --key <KEY>.',
  access: 'open',
  parseArgs: (raw) => {
    const key = (raw.key as string) || (raw._positional as string);
    if (!key) throw new Error('--key is required');
    if (!(key in CONFIG_KEYS)) {
      throw new Error(`Unknown config key: ${key}. Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    }
    return { key: key as keyof ConfigSchema };
  },
  handler: async (args) => {
    const config = readConfig();
    const meta = CONFIG_KEYS[args.key];
    const rawValue = config[args.key];
    const hasValue = rawValue !== undefined;

    let displayValue: string;
    if (hasValue) {
      displayValue = meta.secret ? maskSecret(String(rawValue)) : String(rawValue);
    } else {
      displayValue = String(meta.default) || '(empty)';
    }

    return {
      key: args.key,
      value: displayValue,
      source: hasValue ? 'config' : 'default',
      description: meta.description,
    };
  },
});

// --- ncl config set <key> <value> ---
register({
  name: 'config set',
  description: 'Set a config value. Use --key <KEY> --value <VALUE>.',
  access: 'open',
  parseArgs: (raw) => {
    const key = raw.key as string;
    const value = raw.value as string;
    if (!key) throw new Error('--key is required');
    if (value === undefined || value === null) throw new Error('--value is required');
    if (!(key in CONFIG_KEYS)) {
      throw new Error(`Unknown config key: ${key}. Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    }
    return { key: key as keyof ConfigSchema, value };
  },
  handler: async (args) => {
    const config = readConfig();
    const meta = CONFIG_KEYS[args.key];

    // Coerce numeric values
    if (meta.default !== '' && typeof meta.default === 'number') {
      const num = Number(args.value);
      if (isNaN(num)) throw new Error(`${args.key} must be a number`);
      (config as Record<string, unknown>)[args.key] = num;
    } else {
      (config as Record<string, unknown>)[args.key] = args.value;
    }

    writeConfig(config);

    const displayValue = meta.secret ? maskSecret(String(args.value)) : String(args.value);
    return { key: args.key, value: displayValue, saved: true };
  },
});

// --- ncl config reset <key> ---
register({
  name: 'config reset',
  description: 'Reset a config key to its default. Use --key <KEY>.',
  access: 'open',
  parseArgs: (raw) => {
    const key = (raw.key as string) || (raw._positional as string);
    if (!key) throw new Error('--key is required');
    if (!(key in CONFIG_KEYS)) {
      throw new Error(`Unknown config key: ${key}. Valid keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    }
    return { key: key as keyof ConfigSchema };
  },
  handler: async (args) => {
    const config = readConfig();
    delete (config as Record<string, unknown>)[args.key];
    writeConfig(config);

    const meta = CONFIG_KEYS[args.key];
    return { key: args.key, resetTo: meta.default, description: meta.description };
  },
});
