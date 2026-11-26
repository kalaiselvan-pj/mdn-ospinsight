import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import { pool, ensureSchema, seedUser, seedNetwork, logAction } from "./db.js";
import { geometryBounds, styleFor, DEFAULT_STYLES } from "../scripts/geo.js";
import { importData } from "../scripts/import-data.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "8mb" }));

const TYPE_LABELS = {
  bdg: "Building",
  cab: "Cable",
  ap: "Access Point",
  sp: "Splice Point",
  tp: "Term Point",
  planl: "Plan Line",
  planp: "Plan Point",
  pole: "Pole",
  sla: "Slack",
  db: "Duct Bank",
  pln: "Aerial Strand"
};

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "medianet-ospinsight");
    next();
  } catch {
    res.status(401).json({ error: "Please sign in" });
  }
}

function featureRow(row, includeGeometry) {
  return {
    id: row.id,
    networkId: row.network_id,
    xType: row.x_type,
    typeLabel: TYPE_LABELS[row.x_type] || row.x_type,
    sourceId: row.source_id,
    name: row.name,
    geometry: includeGeometry ? row.geometry : { type: "Point", coordinates: [row.centroid_lng, row.centroid_lat] },
    properties: includeGeometry ? row.properties : { name: row.name },
    style: row.style,
    centroid: { lng: row.centroid_lng, lat: row.centroid_lat },
    simplified: !includeGeometry
  };
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const result = await pool.query("SELECT id, username, display_name, password_hash FROM users WHERE username = $1", [username]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    res.status(401).json({ error: "Login or password is incorrect" });
    return;
  }
  const token = jwt.sign(
    { id: user.id, username: user.username, displayName: user.display_name },
    process.env.JWT_SECRET || "medianet-ospinsight",
    { expiresIn: "12h" }
  );
  await logAction(user.username, "login");
  res.json({ token, user: { username: user.username, displayName: user.display_name } });
});

app.get("/api/bootstrap", auth, async (req, res) => {
  const [networks, defs, catalog, counts, settings, bookmarks] = await Promise.all([
    pool.query("SELECT id, name, designation, version, boundary FROM networks ORDER BY id"),
    pool.query("SELECT x_type, fieldname, caption, fieldorder, visible, required FROM field_defs ORDER BY x_type, fieldorder, caption"),
    pool.query("SELECT id, network_id, category, object_type, name, properties FROM catalog_items ORDER BY object_type, name"),
    pool.query("SELECT network_id, x_type, count(*)::int AS count FROM features GROUP BY network_id, x_type"),
    pool.query("SELECT key, value FROM app_settings"),
    pool.query("SELECT id, network_id, name, lng, lat, zoom FROM bookmarks ORDER BY name")
  ]);
  res.json({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || "",
    user: req.user,
    typeLabels: TYPE_LABELS,
    defaultStyles: DEFAULT_STYLES,
    networks: networks.rows,
    fieldDefs: defs.rows,
    catalog: catalog.rows,
    counts: counts.rows,
    settings: Object.fromEntries(settings.rows.map((row) => [row.key, row.value])),
    bookmarks: bookmarks.rows
  });
});

app.get("/api/features", auth, async (req, res) => {
  const networkId = Number(req.query.networkId);
  const west = Number(req.query.west);
  const south = Number(req.query.south);
  const east = Number(req.query.east);
  const north = Number(req.query.north);
  const zoom = Number(req.query.zoom || 12);
  const types = String(req.query.types || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (![networkId, west, south, east, north].every(Number.isFinite)) {
    res.status(400).json({ error: "networkId and map bounds are required" });
    return;
  }
  const params = [networkId, west, east, south, north];
  let typeSql = "";
  if (types.length) {
    params.push(types);
    typeSql = ` AND x_type = ANY($${params.length})`;
  }
  const where = `network_id = $1 AND max_lng >= $2 AND min_lng <= $3 AND max_lat >= $4 AND min_lat <= $5${typeSql}`;
  const count = await pool.query(`SELECT count(*)::int AS count FROM features WHERE ${where}`, params);
  if (req.query.countOnly === "1" || zoom < 15) {
    res.json({ mode: "overview", total: count.rows[0].count, features: [] });
    return;
  }
  const result = await pool.query(
    `SELECT id, network_id, x_type, source_id, name, geometry, style, centroid_lng, centroid_lat
     FROM features WHERE ${where}
     ORDER BY id
     LIMIT 6000`,
    params
  );
  res.json({
    mode: "shapes",
    total: count.rows[0].count,
    features: result.rows.map((row) => ({
      id: row.id,
      networkId: row.network_id,
      xType: row.x_type,
      typeLabel: TYPE_LABELS[row.x_type] || row.x_type,
      sourceId: row.source_id,
      name: row.name,
      geometry: row.geometry,
      style: row.style,
      centroid: { lng: row.centroid_lng, lat: row.centroid_lat }
    }))
  });
});

app.get("/api/features/:id", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM features WHERE id = $1", [Number(req.params.id)]);
  if (!result.rowCount) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }
  res.json(featureRow(result.rows[0], true));
});

app.get("/api/search", auth, async (req, res) => {
  const networkId = Number(req.query.networkId);
  const q = String(req.query.q || "").trim();
  if (!q) {
    res.json([]);
    return;
  }
  const result = await pool.query(
    `SELECT id, x_type, source_id, name, centroid_lng, centroid_lat
     FROM features
     WHERE network_id = $1 AND (name ILIKE $2 OR source_id::text = $3)
     ORDER BY name
     LIMIT 25`,
    [networkId, `%${q}%`, q]
  );
  res.json(result.rows.map((row) => ({
    id: row.id,
    xType: row.x_type,
    typeLabel: TYPE_LABELS[row.x_type] || row.x_type,
    sourceId: row.source_id,
    name: row.name,
    centroid: { lng: row.centroid_lng, lat: row.centroid_lat }
  })));
});

function cleanFeature(body) {
  const geometry = body.geometry;
  const bounds = geometryBounds(geometry);
  if (!bounds) return null;
  const xType = String(body.xType || "");
  const properties = body.properties && typeof body.properties === "object" ? body.properties : {};
  const name = String(body.name || properties.name || TYPE_LABELS[xType] || "New feature").trim();
  properties.name = properties.name || name;
  const style = body.style && body.style.stroke ? body.style : styleFor(xType, properties);
  return { xType, name, geometry, properties, style, bounds };
}

app.post("/api/features", auth, async (req, res) => {
  const cleaned = cleanFeature(req.body);
  if (!cleaned) {
    res.status(400).json({ error: "A valid geometry is required" });
    return;
  }
  const result = await pool.query(
    `INSERT INTO features (
      network_id, x_type, name, geometry, properties, style,
      min_lng, min_lat, max_lng, max_lat, centroid_lng, centroid_lat
    ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,$12)
    RETURNING *`,
    [
      Number(req.body.networkId), cleaned.xType, cleaned.name,
      JSON.stringify(cleaned.geometry), JSON.stringify(cleaned.properties), JSON.stringify(cleaned.style),
      cleaned.bounds.minLng, cleaned.bounds.minLat, cleaned.bounds.maxLng, cleaned.bounds.maxLat,
      cleaned.bounds.centroidLng, cleaned.bounds.centroidLat
    ]
  );
  await logAction(req.user.username, "create", { id: result.rows[0].id, xType: cleaned.xType, name: cleaned.name });
  res.json(featureRow(result.rows[0], true));
});

app.put("/api/features/:id", auth, async (req, res) => {
  const current = await pool.query("SELECT * FROM features WHERE id = $1", [Number(req.params.id)]);
  if (!current.rowCount) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }
  const existing = current.rows[0];
  const cleaned = cleanFeature({
    xType: req.body.xType || existing.x_type,
    name: req.body.name ?? existing.name,
    geometry: req.body.geometry || existing.geometry,
    properties: req.body.properties || existing.properties,
    style: req.body.style || existing.style
  });
  const result = await pool.query(
    `UPDATE features SET
      name = $2, geometry = $3::jsonb, properties = $4::jsonb, style = $5::jsonb,
      min_lng = $6, min_lat = $7, max_lng = $8, max_lat = $9,
      centroid_lng = $10, centroid_lat = $11, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [
      existing.id, cleaned.name, JSON.stringify(cleaned.geometry), JSON.stringify(cleaned.properties),
      JSON.stringify(cleaned.style), cleaned.bounds.minLng, cleaned.bounds.minLat, cleaned.bounds.maxLng,
      cleaned.bounds.maxLat, cleaned.bounds.centroidLng, cleaned.bounds.centroidLat
    ]
  );
  await logAction(req.user.username, "update", { id: existing.id, name: cleaned.name });
  res.json(featureRow(result.rows[0], true));
});

app.delete("/api/features/:id", auth, async (req, res) => {
  const result = await pool.query("DELETE FROM features WHERE id = $1 RETURNING id, name, x_type", [Number(req.params.id)]);
  if (!result.rowCount) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }
  await logAction(req.user.username, "delete", result.rows[0]);
  res.json({ ok: true });
});

app.get("/api/notes", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT n.*, f.name AS feature_name, f.x_type
     FROM field_notes n LEFT JOIN features f ON f.id = n.feature_id
     WHERE n.network_id = $1 ORDER BY n.created_at DESC LIMIT 200`,
    [Number(req.query.networkId)]
  );
  res.json(result.rows);
});

app.post("/api/notes", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO field_notes (network_id, feature_id, title, body, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [Number(req.body.networkId), req.body.featureId || null, req.body.title || "Field note", req.body.body || "", req.user.username]
  );
  await logAction(req.user.username, "field-note", { id: result.rows[0].id });
  res.json(result.rows[0]);
});

app.put("/api/notes/:id", auth, async (req, res) => {
  const result = await pool.query(
    "UPDATE field_notes SET title = $2, body = $3, status = $4 WHERE id = $1 RETURNING *",
    [Number(req.params.id), req.body.title, req.body.body || "", req.body.status || "open"]
  );
  res.json(result.rows[0]);
});

app.get("/api/alarms", auth, async (req, res) => {
  const result = await pool.query(
    `SELECT a.*, f.name AS feature_name FROM alarms a
     LEFT JOIN features f ON f.id = a.feature_id
     WHERE a.network_id = $1 ORDER BY a.created_at DESC LIMIT 200`,
    [Number(req.query.networkId)]
  );
  res.json(result.rows);
});

app.post("/api/alarms", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO alarms (network_id, feature_id, severity, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [Number(req.body.networkId), req.body.featureId || null, req.body.severity || "warning", req.body.message]
  );
  res.json(result.rows[0]);
});

app.put("/api/alarms/:id", auth, async (req, res) => {
  const result = await pool.query("UPDATE alarms SET status = $2 WHERE id = $1 RETURNING *", [Number(req.params.id), req.body.status || "closed"]);
  res.json(result.rows[0]);
});

app.get("/api/log", auth, async (_req, res) => {
  const result = await pool.query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 300");
  res.json(result.rows);
});

app.get("/api/bookmarks", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM bookmarks WHERE network_id = $1 ORDER BY name", [Number(req.query.networkId)]);
  res.json(result.rows);
});

app.post("/api/bookmarks", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO bookmarks (network_id, name, lng, lat, zoom, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [Number(req.body.networkId), req.body.name, req.body.lng, req.body.lat, req.body.zoom || 16, req.user.username]
  );
  res.json(result.rows[0]);
});

app.delete("/api/bookmarks/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM bookmarks WHERE id = $1", [Number(req.params.id)]);
  res.json({ ok: true });
});

app.post("/api/catalog", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO catalog_items (network_id, category, object_type, name, properties)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING *`,
    [Number(req.body.networkId), req.body.category, req.body.objectType, req.body.name, JSON.stringify(req.body.properties || {})]
  );
  await logAction(req.user.username, "catalog", { name: req.body.name, category: req.body.category });
  res.json(result.rows[0]);
});

app.put("/api/settings", auth, async (req, res) => {
  const entries = Object.entries(req.body || {});
  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)]
    );
  }
  res.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "..", "public")));

const port = Number(process.env.PORT || 8080);

async function start() {
  await ensureSchema();
  await seedUser();
  await seedNetwork();
  const count = await pool.query("SELECT count(*)::int AS count FROM features");
  if (count.rows[0].count === 0) {
    try {
      await importData();
    } catch (error) {
      console.log(`Data import skipped: ${error.message}`);
    }
  }
  app.listen(port, () => {
    console.log(`Medianet OSP Insight listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
