
ALTER TABLE messages ADD COLUMN source_msg_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_source_msg_key
ON messages(source, source_msg_key);

CREATE INDEX IF NOT EXISTS idx_messages_source_rowid
ON messages(source, source_rowid);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_id
ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_extracted_dates_message_id
ON extracted_dates(message_id);

CREATE INDEX IF NOT EXISTS idx_extracted_links_message_id
ON extracted_links(message_id);

CREATE INDEX IF NOT EXISTS idx_extracted_attachments_message_id
ON extracted_attachments(message_id);
