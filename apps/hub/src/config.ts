// Central server configuration. All environment variables are parsed and
// validated here so the rest of the code reads a typed, fail-closed config.
import { deriveSessionKey } from './crypto/keyring.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type AdminRole = 'owner' | 'operator';

export interface HubConfig {
  /** Master key for envelope encryption (W1-3 derives the AES key). */
  masterKey: string;
  /** HKDF subkey (info="sess") used to sign session tokens; independent of
   * the data-encryption key derived from masterKey. */
  sessionKey: string;
  /** Owner (full-access) console username. */
  ownerUsername: string;
  /** Owner console password. */
  adminPassword: string;
  /** Operator (read-only) console username. */
  operatorUsername: string;
  /** Operator password; unset means the operator account is disabled. */
  operatorPassword?: string;
  /** TCP port the HTTP server binds. */
  port: number;
  /** Directory for the SQLite database, cached projections, and key material. */
  dataDir: string;
  /** Disable admin auth for local development only (never on a shared host). */
  devNoAuth: boolean;
  /** Hub base URL the knowledge subdomain pulls its catalog from (usually
   * this hub itself over loopback). */
  knowledgeHubUrl: string;
  /** Project token the knowledge subdomain consumes aliases with. Unset
   * means the knowledge ingest/query endpoints stay disabled. */
  knowledgeProjectToken?: string;
  /** Embedding alias used for document and query vectors. */
  knowledgeEmbedAlias: string;
  /** Text alias used to rerank vector hits; unset skips reranking. */
  knowledgeRerankAlias?: string;
  /** Text alias used to synthesize grounded answers; unset returns
   * citations only. */
  knowledgeAnswerAlias?: string;
  /** Webhook URL that receives budget watermark alerts (80%/100% of an
   * assignment's daily budget). Unset disables budget alerting entirely. */
  budgetWebhookUrl?: string;
  /** HMAC-SHA256 secret used to sign the budget alert webhook body
   * (x-hub-signature header). Optional; strongly recommended whenever the
   * URL is set. */
  budgetWebhookSecret?: string;
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
  const ownerUsername = env.HUB_OWNER_USERNAME || 'owner';
  const operatorUsername = env.HUB_OPERATOR_USERNAME || 'operator';
  const operatorPassword = env.HUB_OPERATOR_PASSWORD || undefined;

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

  return {
    masterKey,
    sessionKey: deriveSessionKey(masterKey),
    ownerUsername,
    adminPassword,
    operatorUsername,
    ...(operatorPassword ? { operatorPassword } : {}),
    port,
    dataDir,
    devNoAuth,
    knowledgeHubUrl:
      env.KNOWLEDGE_HUB_URL || `http://127.0.0.1:${port}`,
    ...(env.KNOWLEDGE_PROJECT_TOKEN
      ? { knowledgeProjectToken: env.KNOWLEDGE_PROJECT_TOKEN }
      : {}),
    knowledgeEmbedAlias: env.KNOWLEDGE_EMBED_ALIAS || 'embed',
    ...(env.KNOWLEDGE_RERANK_ALIAS
      ? { knowledgeRerankAlias: env.KNOWLEDGE_RERANK_ALIAS }
      : {}),
    ...(env.KNOWLEDGE_ANSWER_ALIAS
      ? { knowledgeAnswerAlias: env.KNOWLEDGE_ANSWER_ALIAS }
      : {}),
    ...(env.HUB_BUDGET_WEBHOOK_URL
      ? { budgetWebhookUrl: env.HUB_BUDGET_WEBHOOK_URL }
      : {}),
    ...(env.HUB_BUDGET_WEBHOOK_SECRET
      ? { budgetWebhookSecret: env.HUB_BUDGET_WEBHOOK_SECRET }
      : {}),
  };
}
