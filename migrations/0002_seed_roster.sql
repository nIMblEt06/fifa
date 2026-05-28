-- Seed the roster with the initial player list.
-- Normalized_name is lowercase + trimmed; uniqueness keys lookups for auto-create.

INSERT INTO players (name, normalized_name, created_at) VALUES
  ('Shwetabh',  'shwetabh',  CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Shashvat',  'shashvat',  CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Harsh',     'harsh',     CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Shivang',   'shivang',   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Shobhit',   'shobhit',   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Prateek',   'prateek',   CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Priyanshu', 'priyanshu', CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Aryan',     'aryan',     CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Tarun',     'tarun',     CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Luv',       'luv',       CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Himanshu',  'himanshu',  CAST(strftime('%s','now') AS INTEGER) * 1000),
  ('Rakshit',   'rakshit',   CAST(strftime('%s','now') AS INTEGER) * 1000);
