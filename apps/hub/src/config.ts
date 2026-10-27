// Central server configuration. All environment variables are parsed and
// validated here so the rest of the code reads a typed, fail-closed config.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface HubConfig {
  /** Master key for envelope encryption (W1-3 derives the AES key). */
  masterKey: string;
  /** Fixed admin password for the console session login. */
  adminPassword: string;
  /** TCP port the HTTP server binds. */
  port: number;
  /** Directory for the SQLite database, cached projections, and key material. */
  dataDir: string;
  /** Disable admin auth for local development only (never on a shared host). */
  devNoAuth: boolean;
}

const DEFAULT_PORT = 8791;
const DEFAULT_DATA_DIR = './data';

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`invalid HUB_PORT: ${raw}`);
  }
  return port;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): HubConfig {
  const devNoAuth = env.HUB_DEV_NO_AUTH === '1';
  const masterKey = env.HUB_MASTER_KEY ?? '';
  const adminPassword = env.HUB_ADMIN_PASSWORD ?? '';

  // Fail closed: the server must not start without secrets unless the
  // explicit local-development switch is set.
  if (!devNoAuth) {
    if (masterKey.length < 16) {
      throw new ConfigError(
        'HUB_MASTER_KEY is required (use a long random value, >= 16 chars)',
      );
    }
    if (adminPassword.length < 12) {
      throw new ConfigError(
        'HUB_ADMIN_PASSWORD is required (use a strong value, >= 12 chars)',
      );
    }
  }

  const port = parsePort(env.HUB_PORT);
  const dataDir = env.HUB_DATA_DIR || DEFAULT_DATA_DIR;

  return { masterKey, adminPassword, port, dataDir, devNoAuth };
}
