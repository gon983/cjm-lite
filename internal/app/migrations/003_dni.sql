-- Preserve users, bookings and imported identifiers while adopting DNI terminology.
ALTER TABLE users RENAME COLUMN matricula TO dni;
ALTER TABLE whitelist RENAME COLUMN matricula TO dni;
-- Remove a column-label row accidentally imported as a person.
DELETE FROM whitelist WHERE lower(trim(apellido)) IN ('apellido','apellidos') AND lower(trim(nombre)) IN ('nombre','nombres');
