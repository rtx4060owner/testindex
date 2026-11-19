DROP TABLE IF EXISTS kb_chunks;
DROP TABLE IF EXISTS kb_fts;

CREATE TABLE kb_chunks (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  entity TEXT NOT NULL,
  keywords TEXT NOT NULL,
  content TEXT NOT NULL,
  rules TEXT NOT NULL
);

-- FTS5 Virtual Table for BM25 Keyword Search
CREATE VIRTUAL TABLE kb_fts USING fts5(
  id UNINDEXED,
  category,
  entity,
  keywords,
  content,
  tokenize = 'porter unicode61'
);