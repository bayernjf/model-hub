import { join } from 'node:path';
import { initModelKit, type ModelKit } from '@model-hub/model-kit';
import type { HubConfig } from '../config.js';
import type { KnowledgePorts, KnowledgePortsResolver } from './service.js';

// Production knowledge ports: the hub acts as a consumer of its own
// assignments through model-kit. Embedding calls report usage back through
// the standard /pub/v1/usage path, so embedding spend lands in the cost
// dashboard against the consumer project that owns the aliases.

const RERANK_SYSTEM =
  'You are a search relevance judge. For the given query, score each numbered ' +
  'passage 0-100 for how well it helps answer the query. Respond with strict ' +
  'JSON only, no prose: {"scores":[{"index":0,"score":0}]} with exactly one ' +
  'object per passage.';

const ANSWER_SYSTEM =
  'Answer the question using only the numbered context passages. Cite the ' +
  'passages you used as [n]. If the passages do not contain enough ' +
  'information, say that the knowledge base has no relevant content. Reply ' +
  'in the language of the question.';

function rerankUserPrompt(query: string, contents: string[]): string {
  const passages = contents
    .map((content, i) => `[P${i}] ${content.replaceAll('\n', ' ')}`)
    .join('\n');
  return `Query: ${query}\n\nPassages:\n${passages}`;
}

function answerUserPrompt(query: string, contexts: string[]): string {
  const passages = contexts
    .map((content, i) => `[${i + 1}] ${content}`)
    .join('\n\n');
  return `Context passages:\n${passages}\n\nQuestion: ${query}`;
}

// Parse the judge's score list. Any deviation from the contract throws so
// the caller can fall back to the pure vector order (fail-soft rerank).
export function parseRerankScores(
  content: string,
  expected: number,
): number[] {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('rerank response contains no JSON object');
  }
  const parsed = JSON.parse(content.slice(start, end + 1)) as {
    scores?: Array<{ index?: unknown; score?: unknown }>;
  };
  const scores = parsed.scores;
  if (!Array.isArray(scores) || scores.length !== expected) {
    throw new Error('rerank response has the wrong score count');
  }
  const out: number[] = [];
  for (const entry of scores) {
    const index = entry?.index;
    const score = entry?.score;
    if (
      typeof index !== 'number' ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected
    ) {
      throw new Error('rerank response has an out-of-range index');
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new Error('rerank response has a non-numeric score');
    }
    out[index] = score;
  }
  return out;
}

async function buildPorts(
  config: HubConfig,
  token: string,
): Promise<KnowledgePorts> {
  const kit: ModelKit = await initModelKit({
    token,
    hubUrl: config.knowledgeHubUrl,
    cachePath: join(config.dataDir, 'knowledge-kit-cache.json'),
  });

  const ports: KnowledgePorts = {
    embed: async (inputs) => {
      const result = await kit.embed(config.knowledgeEmbedAlias, inputs);
      if (result.httpStatus >= 400) {
        throw new Error(
          `embedding request failed with HTTP ${result.httpStatus}`,
        );
      }
      if (result.vectors.length !== inputs.length) {
        throw new Error('embedding response count mismatch');
      }
      if (result.vectors.some((v) => v.length === 0)) {
        throw new Error('embedding response contains an empty vector');
      }
      return result.vectors;
    },
  };

  const rerankAlias = config.knowledgeRerankAlias;
  if (rerankAlias) {
    ports.rerank = async (query, contents) => {
      const result = await kit.chat(
        rerankAlias,
        [
          { role: 'system', content: RERANK_SYSTEM },
          { role: 'user', content: rerankUserPrompt(query, contents) },
        ],
        { temperature: 0 },
      );
      return parseRerankScores(result.content, contents.length);
    };
  }

  const answerAlias = config.knowledgeAnswerAlias;
  if (answerAlias) {
    ports.answer = async (query, contexts) => {
      const result = await kit.chat(answerAlias, [
        { role: 'system', content: ANSWER_SYSTEM },
        { role: 'user', content: answerUserPrompt(query, contexts) },
      ]);
      const text = result.content.trim();
      return text.length > 0 ? text : null;
    };
  }

  return ports;
}

// Lazily build (and memoize) the model-kit ports on first knowledge call.
// Returns null immediately when the consumer token is unset, which the
// service surfaces as KnowledgeNotConfiguredError.
export function createKnowledgePortsResolver(
  config: HubConfig,
): KnowledgePortsResolver {
  const token = config.knowledgeProjectToken;
  if (!token) return async () => null;

  let cached: Promise<KnowledgePorts> | null = null;
  return () => {
    cached ??= buildPorts(config, token).catch((err: unknown) => {
      cached = null; // retry on the next call after a transient failure
      throw err;
    });
    return cached;
  };
}
