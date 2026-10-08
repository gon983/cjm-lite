-- Keep the chosen scope in export history even after mediation retention cleanup.
ALTER TABLE exports ADD COLUMN sede TEXT NOT NULL DEFAULT '';
CREATE INDEX exports_site_id ON exports(sede,id);
