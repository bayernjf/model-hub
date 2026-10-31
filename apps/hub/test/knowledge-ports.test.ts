import { describe, expect, it } from 'vitest';
import { parseRerankScores } from '../src/knowledge/ports.js';
import { loadConfig } from '../src/config.js';
import { createKnowledgePortsResolver } from '../src/knowledge/ports.js';

describe('parseRerankScores', () => {
  it('parses scores embedded in surrounding prose', () => {
    const content =
      'Sure! {"scores":[{"index":1,"score":88},{"index":0,"score":12.5}]} done';
    expect(parseRerankScores(content, 2)).toEqual([12.5, 88]);
  });

  it('throws on non-JSON, wrong counts, bad indices and non-numeric scores', () => {
    expect(() => parseRerankScores('no json here', 2)).toThrow();
    expect(() => parseRerankScores('{"scores":[]}', 2)).toThrow();
    expect(() =>
      parseRerankScores('{"scores":[{"index":0,"score":1}]}', 2),
    ).toThrow();
    expect(() =>
      parseRerankScores(
        '{"scores":[{"index":5,"score":1},{"index":1,"score":2}]}',
        2,
      ),
    ).toThrow();
    expect(() =>
      parseRerankScores(
        '{"scores":[{"index":0,"score":"high"},{"index":1,"score":2}]}',
        2,
      ),
    ).toThrow();
  });
});

describe('knowledge ports resolver', () => {
  it('resolves to null when the consumer token is unset', async () => {
    const config = loadConfig({
      HUB_DEV_NO_AUTH: '1',
    });
    const resolve = createKnowledgePortsResolver(config);
    expect(await resolve()).toBeNull();
  });
});
