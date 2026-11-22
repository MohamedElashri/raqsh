CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    root TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL
) STRICT;

CREATE TABLE boards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    semantic_revision INTEGER NOT NULL DEFAULT 0,
    drawing_revision INTEGER NOT NULL DEFAULT 0,
    drawing TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX boards_by_project ON boards(project_id, updated_at DESC, id);

CREATE TABLE nodes (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (board_id, id)
) WITHOUT ROWID, STRICT;

CREATE TABLE edges (
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (board_id, id)
) WITHOUT ROWID, STRICT;

CREATE TABLE receipts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    request TEXT NOT NULL,
    response TEXT NOT NULL
) STRICT;
CREATE INDEX receipts_by_board ON receipts(board_id);
