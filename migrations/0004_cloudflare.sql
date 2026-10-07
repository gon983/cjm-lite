ALTER TABLE users ADD COLUMN search_text TEXT NOT NULL DEFAULT '';
ALTER TABLE mediations ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
CREATE INDEX users_role_active ON users(role,active,apellido,nombre);
CREATE INDEX users_email ON users(email);
CREATE INDEX mediations_date_state_result ON mediations(date,state,result,start);
CREATE INDEX mediations_export ON mediations(exported_at,date);
CREATE INDEX blocked_days_date ON blocked_days(date,sede);
CREATE TABLE login_attempts(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX login_attempts_expiry ON login_attempts(expires_at);
-- Export manifest keeps the exact versions present in a successfully generated file.
ALTER TABLE exports ADD COLUMN manifest TEXT NOT NULL DEFAULT '[]';
