DROP TABLE IF EXISTS kb_chunks;
DROP TABLE IF EXISTS kb_fts;

CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY,
  department TEXT NOT NULL DEFAULT 'Internal Medicine',
  category TEXT NOT NULL,
  entity TEXT NOT NULL,
  keywords TEXT NOT NULL,
  content TEXT NOT NULL,
  rules TEXT NOT NULL
);

-- FTS5 Virtual Table for BM25 Keyword Search
CREATE VIRTUAL TABLE kb_fts USING fts5(
  id UNINDEXED,
  department UNINDEXED,
  category,
  entity,
  keywords,
  content,
  tokenize = 'porter unicode61'
);