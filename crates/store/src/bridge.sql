ALTER TABLE receipts ADD COLUMN revision INTEGER;
UPDATE receipts SET revision = json_extract(response, '$.revision');
CREATE UNIQUE INDEX receipt_revision ON receipts(board_id, revision);

CREATE TABLE bindings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    board_id TEXT REFERENCES boards(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    secret_hash BLOB NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX bindings_by_project ON bindings(project_id, board_id);

CREATE TABLE feedback (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','offered','acknowledged','cancelled')),
    ack_id TEXT UNIQUE,
    response_id TEXT UNIQUE,
    response TEXT,
    created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX feedback_recipient ON feedback(binding_id, board_id, sequence);

CREATE TABLE board_creations (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES bindings(id) ON DELETE CASCADE,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL
) STRICT;
