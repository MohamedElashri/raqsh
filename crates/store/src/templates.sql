CREATE TABLE IF NOT EXISTS board_templates (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    card_count INTEGER NOT NULL,
    data TEXT NOT NULL
) STRICT;
