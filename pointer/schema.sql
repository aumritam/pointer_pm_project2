-- Create feedback table with required columns and indexes
CREATE TABLE IF NOT EXISTS feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    sentiment TEXT,
    theme TEXT,
    created_at DATETIME NOT NULL
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_theme ON feedback(theme);
