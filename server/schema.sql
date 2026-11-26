CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  username text UNIQUE NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS networks (
  id serial PRIMARY KEY,
  name text NOT NULL,
  designation text,
  version text,
  boundary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS features (
  id serial PRIMARY KEY,
  network_id integer NOT NULL REFERENCES networks(id) ON DELETE CASCADE,
  x_type text NOT NULL,
  source_id integer,
  name text NOT NULL DEFAULT '',
  geometry jsonb NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}',
  style jsonb NOT NULL DEFAULT '{}',
  min_lng double precision,
  min_lat double precision,
  max_lng double precision,
  max_lat double precision,
  centroid_lng double precision,
  centroid_lat double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS features_source_uidx
  ON features(network_id, x_type, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS features_bbox_idx
  ON features(network_id, min_lng, max_lng, min_lat, max_lat);
CREATE INDEX IF NOT EXISTS features_name_idx ON features(network_id, lower(name));

CREATE TABLE IF NOT EXISTS field_defs (
  id serial PRIMARY KEY,
  x_type text NOT NULL,
  fieldname text NOT NULL,
  caption text NOT NULL,
  fieldorder integer NOT NULL DEFAULT 0,
  visible boolean NOT NULL DEFAULT true,
  required boolean NOT NULL DEFAULT false,
  UNIQUE (x_type, fieldname)
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id serial PRIMARY KEY,
  network_id integer REFERENCES networks(id) ON DELETE CASCADE,
  category text NOT NULL,
  object_type text NOT NULL,
  name text NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS field_notes (
  id serial PRIMARY KEY,
  network_id integer REFERENCES networks(id) ON DELETE CASCADE,
  feature_id integer REFERENCES features(id) ON DELETE SET NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS alarms (
  id serial PRIMARY KEY,
  network_id integer REFERENCES networks(id) ON DELETE CASCADE,
  feature_id integer REFERENCES features(id) ON DELETE SET NULL,
  severity text NOT NULL DEFAULT 'warning',
  message text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookmarks (
  id serial PRIMARY KEY,
  network_id integer REFERENCES networks(id) ON DELETE CASCADE,
  name text NOT NULL,
  lng double precision NOT NULL,
  lat double precision NOT NULL,
  zoom integer NOT NULL DEFAULT 16,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_log (
  id serial PRIMARY KEY,
  username text,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL
);
