# Knowledge Base API (F3 / M3)

Owner-scoped document ingestion and retrieval over the hub's own model
assignments. Intended consumers (W3-5): loom / atlas service integrations via
a project token; the admin console is a convenience surface, not the only
entry point.

## Authentication

All endpoints require a project token:

```text
Authorization: Bearer mh_<64 hex>
```

The authenticated project is the **owner**. Documents are invisible and
unmodifiable to every other owner (listing, querying and deleting are all
owner-scoped). Tokens are minted in the console (`项目 → 轮换 Token`).

## Endpoints

### POST /api/v1/knowledge/ingest

Split → embed → store. All-or-nothing: the document only appears once every
chunk carries a vector. Each embed call reports input tokens through the
standard usage path, so embedding spend shows up in the cost dashboard.

Request:

```json
{
  "title": "退款政策",
  "text": "…document body…",
  "mime": "text/markdown",
  "source": "api",
  "chunk_size": 1000,
  "chunk_overlap": 200
}
```

- `title` (1–300 chars, required), `text` (1–200 000 chars, required)
- `mime`: `text/plain` | `text/markdown` (default `text/plain`). PDF is
  **not supported yet** — a title ending in `.pdf` (or a `pdf` mime) returns
  `422 unsupported_media_type`.
- `chunk_size` (100–4000, default 1000), `chunk_overlap` (0 ≤ overlap <
  size, default 200). Documents splitting into more than 500 chunks are
  rejected.

Response `201`:

```json
{
  "document": {
    "id": "doc_…", "owner": "prj_…", "title": "退款政策",
    "source": "api", "mime": "text/markdown", "created_at": "…"
  },
  "chunk_count": 12
}
```

### POST /api/v1/knowledge/query

Vector top-k (brute-force cosine over the owner's chunks) → optional LLM
rerank → optional grounded answer. **Fail-soft**: rerank or answer failures
never fail the request; `reranked` reports whether the reranker actually
reordered the vector results.

Request:

```json
{ "query": "我们的退款政策是什么？", "top_k": 5, "rerank": true }
```

- `top_k` 1–50 (default 5), `rerank` default `true` (ignored when no rerank
  alias is configured).

Response `200`:

```json
{
  "query": "我们的退款政策是什么？",
  "top_k": 5,
  "answer": "退款窗口为购买后 30 天 [1]。",
  "reranked": true,
  "citations": [
    {
      "chunk_id": "chk_…",
      "doc_id": "doc_…",
      "title": "退款政策",
      "position": 0,
      "score": 0.93,
      "content": "…chunk text…"
    }
  ]
}
```

`answer` is `null` when no answer alias is configured or generation failed;
citations remain usable.

### GET /api/v1/knowledge/documents

`200 { "documents": [ { …, "chunk_count": 12 } ] }` — newest first, owner
scoped.

### DELETE /api/v1/knowledge/documents/:id

`200 { "deleted": true }`; `404 not_found` when the document does not exist
**or belongs to another owner**.

## Errors

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `unauthorized` | Missing/unknown/disabled token |
| 400 | `validation_error` | Body failed schema validation |
| 404 | `not_found` | Document absent for this owner |
| 422 | `unsupported_media_type` | PDF (not supported yet) |
| 429 | `rate_limited` | Per-project budget exhausted (30 ingest/h, 120 query/h) |
| 502 | `embedding_failed` | The embedding alias call failed |
| 503 | `knowledge_not_configured` | Hub has no `KNOWLEDGE_PROJECT_TOKEN` |

## Hub configuration (owner)

The hub consumes its own assignments through model-kit; configure in
`apps/hub/.env.local`:

```bash
KNOWLEDGE_PROJECT_TOKEN=mh_…   # token of the project owning the aliases
KNOWLEDGE_EMBED_ALIAS=embed    # embedding alias (default: embed)
KNOWLEDGE_RERANK_ALIAS=…       # optional text alias for rerank
KNOWLEDGE_ANSWER_ALIAS=…       # optional text alias for grounded answers
KNOWLEDGE_HUB_URL=…            # optional, defaults to loopback:<HUB_PORT>
```

Unset `KNOWLEDGE_PROJECT_TOKEN` disables ingest/query with `503` while
document listing/deletion keep working.
