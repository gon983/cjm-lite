-- Supports marking only the row versions included in a durable export.
CREATE INDEX mediations_id_version ON mediations(id,version);
