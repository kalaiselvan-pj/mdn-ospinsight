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

function spliceStyle(xType, style) {
  if (xType !== "sp") return style;
  return { ...(style || {}), kind: "point", fill: "#FFFF00", stroke: "#000000", weight: 1 };
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
    style: spliceStyle(row.x_type, row.style),
    centroid: { lng: row.centroid_lng, lat: row.centroid_lat },
    simplified: !includeGeometry
  };
}

const LINK_FIELD_TO_TYPE = {
  buildingid: "bdg",
  access_pointid: "ap",
  enclosureid: "sp",
  fibermngrid: "tp",
  cableid: "cab",
  poleid: "pole",
  planlineid: "planl",
  planpointid: "planp"
};

const XTABLE_TO_TYPE = {
  building: "bdg",
  access_point: "ap",
  accesspoint: "ap",
  enclosure: "sp",
  splice: "sp",
  splice_point: "sp",
  cable: "cab",
  pole: "pole",
  fibermngr: "tp",
  term_point: "tp",
  termination: "tp"
};

const REVERSE_LINKS = {
  bdg: "buildingid",
  ap: "access_pointid",
  cab: "cableid",
  sp: "enclosureid",
  tp: "fibermngrid",
  pole: "poleid"
};

function relatedSummary(row, role) {
  return {
    id: row.id,
    xType: row.x_type,
    typeLabel: TYPE_LABELS[row.x_type] || row.x_type,
    sourceId: row.source_id,
    name: row.name,
    style: row.style,
    centroid: { lng: row.centroid_lng, lat: row.centroid_lat },
    role
  };
}

async function loadRelated(row) {
  const related = [];
  const seen = new Set([row.id]);
  const add = (item, role) => {
    if (!item || seen.has(item.id)) return;
    seen.add(item.id);
    related.push(relatedSummary(item, role));
  };
  const props = row.properties && typeof row.properties === "object" ? row.properties : {};

  for (const [field, xType] of Object.entries(LINK_FIELD_TO_TYPE)) {
    const sourceId = Number(props[field]);
    if (!Number.isFinite(sourceId) || sourceId <= 0) continue;
    if (xType === row.x_type && sourceId === row.source_id) continue;
    const found = await pool.query(
      "SELECT id, x_type, source_id, name, style, centroid_lng, centroid_lat FROM features WHERE network_id = $1 AND x_type = $2 AND source_id = $3 LIMIT 1",
      [row.network_id, xType, sourceId]
    );
    if (found.rowCount) add(found.rows[0], field);
  }

  const tableType = XTABLE_TO_TYPE[String(props.x_table || "").toLowerCase().replace(/\s+/g, "_")];
  const tableId = Number(props.x_id);
  if (tableType && Number.isFinite(tableId) && tableId > 0) {
    const found = await pool.query(
      "SELECT id, x_type, source_id, name, style, centroid_lng, centroid_lat FROM features WHERE network_id = $1 AND x_type = $2 AND source_id = $3 LIMIT 1",
      [row.network_id, tableType, tableId]
    );
    if (found.rowCount) add(found.rows[0], "location");
  }

  const reverseField = REVERSE_LINKS[row.x_type];
  if (reverseField && row.source_id) {
    const found = await pool.query(
      `SELECT id, x_type, source_id, name, style, centroid_lng, centroid_lat
       FROM features
       WHERE network_id = $1 AND id <> $2 AND (properties->>$3) = $4
       ORDER BY x_type, name
       LIMIT 40`,
      [row.network_id, row.id, reverseField, String(row.source_id)]
    );
    for (const item of found.rows) add(item, reverseField);
  }

  const pad = 0.00008;
  const nearby = await pool.query(
    `SELECT id, x_type, source_id, name, style, centroid_lng, centroid_lat
     FROM features
     WHERE network_id = $1 AND id <> $2
       AND max_lng >= $3 AND min_lng <= $4 AND max_lat >= $5 AND min_lat <= $6
     ORDER BY x_type, name
     LIMIT 24`,
    [
      row.network_id,
      row.id,
      Number(row.min_lng) - pad,
      Number(row.max_lng) + pad,
      Number(row.min_lat) - pad,
      Number(row.max_lat) + pad
    ]
  );
  for (const item of nearby.rows) add(item, "nearby");
  return related;
}

function pointInRing(lng, lat, ring) {
  if (!ring || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
  }
  return inside;
}

function geometryContains(geometry, lng, lat) {
  if (!geometry) return false;
  if (geometry.type === "Polygon") return pointInRing(lng, lat, geometry.coordinates?.[0]);
  if (geometry.type === "MultiPolygon") {
    return (geometry.coordinates || []).some((polygon) => pointInRing(lng, lat, polygon[0]));
  }
  return false;
}

function lineDistanceMeters(geometry, lng, lat) {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates || [];
  let best = Infinity;
  const cos = Math.cos(lat * Math.PI / 180);
  const px = lng * 111320 * cos;
  const py = lat * 110540;
  for (const line of lines) {
    if (!Array.isArray(line)) continue;
    for (let i = 1; i < line.length; i += 1) {
      const ax = line[i - 1][0] * 111320 * cos;
      const ay = line[i - 1][1] * 110540;
      const bx = line[i][0] * 111320 * cos;
      const by = line[i][1] * 110540;
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
    }
  }
  return best;
}

function pointDistanceMeters(lng1, lat1, lng2, lat2) {
  const cos = Math.cos(lat1 * Math.PI / 180);
  return Math.hypot((lng1 - lng2) * 111320 * cos, (lat1 - lat2) * 110540);
}

function hitsPoint(row, lng, lat, threshold) {
  const geometry = row.geometry;
  if (!geometry) {
    return pointDistanceMeters(lng, lat, row.centroid_lng, row.centroid_lat) <= threshold;
  }
  if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") return geometryContains(geometry, lng, lat);
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    return lineDistanceMeters(geometry, lng, lat) <= threshold;
  }
  if (geometry.type === "Point") {
    return pointDistanceMeters(lng, lat, geometry.coordinates[0], geometry.coordinates[1]) <= threshold;
  }
  return pointDistanceMeters(lng, lat, row.centroid_lng, row.centroid_lat) <= threshold;
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
      style: spliceStyle(row.x_type, row.style),
      centroid: { lng: row.centroid_lng, lat: row.centroid_lat }
    }))
  });
});

app.get("/api/identify", auth, async (req, res) => {
  const networkId = Number(req.query.networkId);
  const lng = Number(req.query.lng);
  const lat = Number(req.query.lat);
  const pad = Number(req.query.pad) || 0.00012;
  const threshold = Number(req.query.threshold) || 12;
  if (![networkId, lng, lat].every(Number.isFinite)) {
    res.status(400).json({ error: "networkId, lng and lat are required" });
    return;
  }
  const result = await pool.query(
    `SELECT id, network_id, x_type, source_id, name, style, properties, geometry,
            centroid_lng, centroid_lat, min_lng, min_lat, max_lng, max_lat
     FROM features
     WHERE network_id = $1
       AND max_lng >= $2 AND min_lng <= $3 AND max_lat >= $4 AND min_lat <= $5
     ORDER BY id
     LIMIT 120`,
    [networkId, lng - pad, lng + pad, lat - pad, lat + pad]
  );
  const rank = { sp: 0, cab: 1, ap: 2, tp: 3, bdg: 4, pole: 5, sla: 6, db: 7, pln: 8, planl: 9, planp: 10 };
  const geometric = result.rows.filter((row) => hitsPoint(row, lng, lat, threshold) || hitsPoint(row, lng, lat, 28));
  const seen = new Set(geometric.map((row) => row.id));
  const extras = [];
  for (const hit of geometric) {
    if (!["ap", "bdg", "sp"].includes(hit.x_type) || !hit.source_id) continue;
    const field = hit.x_type === "bdg" ? "buildingid" : hit.x_type === "ap" ? "access_pointid" : "enclosureid";
    const linked = await pool.query(
      `SELECT id, network_id, x_type, source_id, name, style, centroid_lng, centroid_lat
       FROM features
       WHERE network_id = $1 AND x_type IN ('sp', 'cab', 'tp', 'ap', 'bdg')
         AND id <> $2
         AND (
           (properties->>$3) = $4
           OR ((properties->>'x_id') = $4 AND (properties->>'x_table') IS NOT NULL)
         )
       ORDER BY x_type, name
       LIMIT 30`,
      [hit.network_id, hit.id, field, String(hit.source_id)]
    );
    for (const row of linked.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      extras.push(row);
    }
  }
  const hits = [...geometric, ...extras].map((row) => ({
    id: row.id,
    networkId: row.network_id,
    xType: row.x_type,
    typeLabel: TYPE_LABELS[row.x_type] || row.x_type,
    sourceId: row.source_id,
    name: row.name,
    style: row.style,
    centroid: { lng: row.centroid_lng, lat: row.centroid_lat }
  })).sort((a, b) => (rank[a.xType] ?? 20) - (rank[b.xType] ?? 20) || String(a.name).localeCompare(String(b.name)));
  res.json(hits);
});

app.get("/api/features/:id", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM features WHERE id = $1", [Number(req.params.id)]);
  if (!result.rowCount) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }
  const row = result.rows[0];
  const payload = featureRow(row, true);
  payload.related = await loadRelated(row);
  res.json(payload);
});

const FIBER_COLORS = [
  { name: "Blue", hex: "#0072C6" },
  { name: "Orange", hex: "#FF8C00" },
  { name: "Green", hex: "#228B22" },
  { name: "Brown", hex: "#8B4513" },
  { name: "Slate", hex: "#708090" },
  { name: "White", hex: "#F4F4F4" },
  { name: "Red", hex: "#DC143C" },
  { name: "Black", hex: "#111111" },
  { name: "Yellow", hex: "#FFD000" },
  { name: "Violet", hex: "#7B1FA2" },
  { name: "Rose", hex: "#FF69B4" },
  { name: "Aqua", hex: "#00CED1" }
];

function fiberCount(properties = {}, name = "") {
  const text = [
    properties.typesize, properties.typ, properties.spanid, properties.ea1, name
  ].map((value) => String(value || "")).join(" ");
  const match = text.match(/(\d+)\s*C\b/i) || text.match(/\b(6|8|12|24|36|48|72|96|144|288)\b/);
  return match ? Number(match[1]) : 12;
}

function fiberList(count) {
  return Array.from({ length: count }, (_, index) => {
    const color = FIBER_COLORS[index % FIBER_COLORS.length];
    return { no: index + 1, color: color.name, hex: color.hex, tube: Math.floor(index / 12) + 1 };
  });
}

async function cablesForSplice(row) {
  const cableIds = [];
  const seen = new Set();
  const addIds = (rows) => {
    for (const item of rows) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      cableIds.push(item.id);
    }
  };
  if (row.source_id) {
    const field = row.x_type === "ap" ? "access_pointid" : row.x_type === "bdg" ? "buildingid" : row.x_type === "sp" ? "enclosureid" : "access_pointid";
    const byLink = await pool.query(
      `SELECT id FROM features
       WHERE network_id = $1 AND x_type = 'cab' AND (properties->>$2) = $3
       ORDER BY name LIMIT 20`,
      [row.network_id, field, String(row.source_id)]
    );
    addIds(byLink.rows);
  }
  const related = await loadRelated(row);
  addIds(related.filter((item) => item.xType === "cab"));
  const pad = row.x_type === "ap" || row.x_type === "tp" ? 0.00045 : 0.00012;
  const nearby = await pool.query(
    `SELECT id FROM features
     WHERE network_id = $1 AND x_type = 'cab' AND id <> $2
       AND max_lng >= $3 AND min_lng <= $4 AND max_lat >= $5 AND min_lat <= $6
     ORDER BY name LIMIT 12`,
    [row.network_id, row.id, Number(row.min_lng) - pad, Number(row.max_lng) + pad, Number(row.min_lat) - pad, Number(row.max_lat) + pad]
  );
  addIds(nearby.rows);
  if (!cableIds.length) return [];
  const cables = await pool.query(
    `SELECT id, source_id, name, x_type, properties, style, centroid_lng, centroid_lat
     FROM features WHERE id = ANY($1::int[]) ORDER BY source_id, name`,
    [cableIds]
  );
  return cables.rows.map((cable) => {
    const count = fiberCount(cable.properties, cable.name);
    return {
      id: cable.id,
      sourceId: cable.source_id,
      name: cable.name,
      typeLabel: "Cable",
      style: cable.style,
      properties: cable.properties,
      fiberCount: count,
      fibers: fiberList(count),
      centroid: { lng: cable.centroid_lng, lat: cable.centroid_lat }
    };
  });
}

app.get("/api/features/:id/splice-key", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM features WHERE id = $1", [Number(req.params.id)]);
  if (!result.rowCount) {
    res.status(404).json({ error: "Feature not found" });
    return;
  }
  const opened = result.rows[0];
  const ctx = await enclosureContext(opened);
  const row = ctx.enclosure;
  const [cables, pairs, files, notes] = await Promise.all([
    cablesForSplice(row),
    pool.query("SELECT * FROM splice_pairs WHERE splice_id = ANY($1::int[]) ORDER BY id", [[row.id, opened.id]]),
    pool.query("SELECT * FROM object_files WHERE feature_id = ANY($1::int[]) ORDER BY created_at DESC", [[row.id, opened.id]]),
    pool.query("SELECT * FROM field_notes WHERE feature_id = ANY($1::int[]) ORDER BY created_at DESC", [[row.id, opened.id]])
  ]);
  let mapped = pairs.rows.map((pair) => ({
    id: pair.id,
    aCableId: pair.a_cable_id,
    aFiber: pair.a_fiber,
    bCableId: pair.b_cable_id,
    bFiber: pair.b_fiber,
    kind: pair.kind
  }));
  if (!mapped.length && cables.length >= 2) {
    const count = Math.min(cables[0].fiberCount, cables[1].fiberCount);
    mapped = Array.from({ length: count }, (_, index) => ({
      aCableId: cables[0].id,
      aFiber: index + 1,
      bCableId: cables[1].id,
      bFiber: index + 1,
      kind: "suggested"
    }));
  }
  const related = await loadRelated(row);
  const header = spliceHeader(ctx);
  const splitters = await loadSplitters(ctx, notes.rows);
  const ranked = cables
    .map((cable) => ({
      cable,
      dist: Math.hypot(
        Number(cable.centroid?.lng || 0) - Number(row.centroid_lng || 0),
        Number(cable.centroid?.lat || 0) - Number(row.centroid_lat || 0)
      )
    }))
    .sort((a, b) => a.dist - b.dist);
  const nearest = ranked[0]?.dist || 0;
  const cutoff = Math.max(nearest * 3, 0.00004);
  const spanCables = ranked.filter((item) => item.dist <= cutoff).slice(0, 4).map((item) => item.cable);
  res.json({
    splice: { ...featureRow(opened, true), related },
    cables,
    pairs: mapped,
    files: files.rows,
    notes: notes.rows,
    header,
    splitters,
    spans: spanCables.map((cable, index) => {
      const count = Number(cable.fiberCount) || 12;
      return {
        id: cable.id,
        span: cable.properties?.spanid || cable.sourceId || cable.name,
        name: cable.name,
        locateId: `SP${index + 1}`,
        seq: cable.properties?.placement && cable.properties.placement !== "none"
          ? String(cable.properties.placement)
          : ["0", "0", "0 m"].join("\\"),
        count,
        ports: [`1-${count}`]
      };
    })
  });
});

async function enclosureContext(row) {
  let enclosure = row;
  let access = row.x_type === "ap" ? row : null;
  let building = row.x_type === "bdg" ? row : null;
  const props = row.properties || {};
  if (row.x_type === "ap") {
    const splice = await pool.query(
      `SELECT * FROM features
       WHERE network_id = $1 AND x_type = 'sp'
         AND (name = $2 OR (properties->>'access_pointid') = $3)
       ORDER BY CASE WHEN name = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [row.network_id, row.name, String(row.source_id)]
    );
    if (splice.rowCount) enclosure = splice.rows[0];
  } else if (row.x_type === "sp") {
    const apId = Number(props.access_pointid);
    if (Number.isFinite(apId) && apId > 0) {
      const ap = await pool.query(
        `SELECT * FROM features WHERE network_id = $1 AND x_type = 'ap' AND source_id = $2 LIMIT 1`,
        [row.network_id, apId]
      );
      if (ap.rowCount) access = ap.rows[0];
    }
  }
  const locId = Number(
    (building || {}).source_id
    || props.buildingid
    || (access || {}).properties?.buildingid
    || (enclosure.properties || {}).buildingid
    || (enclosure.properties || {}).x_id
    || props.x_id
  );
  if (!building && Number.isFinite(locId) && locId > 0) {
    const found = await pool.query(
      `SELECT * FROM features WHERE network_id = $1 AND x_type = 'bdg' AND source_id = $2 LIMIT 1`,
      [row.network_id, locId]
    );
    if (found.rowCount) building = found.rows[0];
  }
  return { opened: row, enclosure, access, building };
}

function addressOf(row) {
  const props = (row && row.properties) || {};
  return {
    street: props.street || "",
    city: props.city || "",
    state: props.state || "",
    addressNotes: props.addressnotes || "none"
  };
}

function spliceHeader(ctx) {
  const row = ctx.opened;
  const props = row.properties || {};
  const loc = addressOf(ctx.building) ;
  const fromAp = addressOf(ctx.access);
  const self = addressOf(row);
  const street = loc.street || fromAp.street || self.street;
  const city = loc.city || fromAp.city || self.city;
  const state = loc.state || fromAp.state || self.state;
  const notes = loc.addressNotes !== "none" ? loc.addressNotes : (fromAp.addressNotes || self.addressNotes || "none");
  return {
    name: row.name,
    location: [street, city, state].map((part) => String(part || "").trim()).filter(Boolean).join(", ") || "none",
    addressNotes: notes || "none",
    manufacturer: props.installcompany || (ctx.access && ctx.access.properties?.installcompany) || "Sun telecom",
    partNumber: props.partnumber || "none",
    comments: props.splicecomments || ""
  };
}

function splitterCard(name, ratio = 4) {
  const outputs = Number(ratio) || 4;
  return {
    name,
    locateId: "null",
    seq: "null",
    count: outputs + 1,
    ports: [`2-${outputs + 1}`, "1-1"]
  };
}

function parseSplitterNames(text) {
  const names = [];
  const add = (name) => {
    const value = String(name || "").trim().toUpperCase();
    if (value && !names.includes(value)) names.push(value);
  };
  const after = String(text || "").split(/splitter\s*:?-?/i)[1] || "";
  const source = after || text || "";
  for (const line of String(source).split(/\n/)) {
    const match = line.trim().match(/^([0-9]*WSP[0-9A-Z]+|R\d{2,3})\b/i);
    if (match) add(match[1]);
  }
  if (!names.length) {
    for (const match of String(text || "").matchAll(/\b([0-9]*WSP[0-9A-Z]+|R\d{2,3})\b/gi)) add(match[1]);
  }
  const way = String(text || "").match(/(\d+)\s*(?:way|x)\s*splitter(?:\s*x\s*(\d+))?/i);
  if (!names.length && way) {
    const copies = Math.min(4, Number(way[2] || 1));
    const ratio = Number(way[1]) || 4;
    return Array.from({ length: copies }, (_, index) => splitterCard(`R${String(index + 1).padStart(2, "0")}`, ratio === 4 || ratio === 8 || ratio === 16 ? ratio : 4));
  }
  return names.slice(0, 8).map((name) => splitterCard(name, /8WSP|^R/i.test(name) ? 8 : 4));
}

async function loadSplitters(ctx, notes) {
  const rows = [ctx.opened, ctx.enclosure, ctx.access, ctx.building].filter(Boolean);
  const texts = [];
  for (const item of rows) {
    const props = item.properties || {};
    texts.push(props.comments, props.splicecomments, props.enclosurecomments);
  }
  for (const note of notes || []) texts.push(note.title, note.body);
  const linked = await pool.query(
    `SELECT properties, name FROM features
     WHERE network_id = $1 AND x_type IN ('sp', 'ap', 'tp')
       AND (
         name = $2
         OR (properties->>'access_pointid') = $3
         OR (properties->>'enclosureid') = $4
       )
     LIMIT 40`,
    [
      ctx.enclosure.network_id,
      ctx.opened.name,
      String((ctx.access || ctx.opened).source_id || ""),
      String((ctx.enclosure.properties || {}).enclosureid || ctx.enclosure.source_id || "")
    ]
  );
  for (const item of linked.rows) {
    texts.push(item.properties?.comments, item.properties?.splicecomments);
  }
  const saved = await pool.query(
    `SELECT name, properties FROM catalog_items
     WHERE category = 'splitter'
       AND (
         (properties->>'spliceId') IN ($1, $2)
         OR (properties->>'enclosureid') IN ($3, $4)
       )`,
    [
      String(ctx.opened.id),
      String(ctx.enclosure.id),
      String(ctx.opened.source_id || ""),
      String(ctx.enclosure.source_id || "")
    ]
  );
  if (saved.rowCount) {
    return saved.rows.map((item, index) => splitterCard(item.name || `R${String(index + 1).padStart(2, "0")}`, 4));
  }
  const parsed = parseSplitterNames(texts.filter(Boolean).join("\n"));
  if (parsed.length) return parsed;
  const label = `${ctx.opened.name || ""} ${ctx.opened.x_type} ${(ctx.access || ctx.opened).properties?.typ || ""}`;
  if (!/fdc|enclosure|cabinet|sp|ap/i.test(label)) return [];
  return [splitterCard("R01", 4), splitterCard("R02", 4)];
}

app.put("/api/features/:id/splice-key", auth, async (req, res) => {
  const spliceId = Number(req.params.id);
  const pairs = Array.isArray(req.body.pairs) ? req.body.pairs : [];
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM splice_pairs WHERE splice_id = $1", [spliceId]);
    for (const pair of pairs) {
      await client.query(
        `INSERT INTO splice_pairs (splice_id, a_cable_id, a_fiber, b_cable_id, b_fiber, kind)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [spliceId, Number(pair.aCableId), Number(pair.aFiber), Number(pair.bCableId), Number(pair.bFiber), pair.kind || "splice"]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  await logAction(req.user.username, "splice-key", { id: spliceId, pairs: pairs.length });
  res.json({ ok: true, count: pairs.length });
});

app.get("/api/features/:id/files", auth, async (req, res) => {
  const result = await pool.query("SELECT * FROM object_files WHERE feature_id = $1 ORDER BY created_at DESC", [Number(req.params.id)]);
  res.json(result.rows);
});

app.post("/api/features/:id/files", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO object_files (feature_id, name, note, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
    [Number(req.params.id), req.body.name || "File", req.body.note || "", req.user.username]
  );
  res.json(result.rows[0]);
});

app.post("/api/work-orders", auth, async (req, res) => {
  const result = await pool.query(
    `INSERT INTO work_orders (feature_id, title, created_by) VALUES ($1,$2,$3) RETURNING *`,
    [Number(req.body.featureId), req.body.title || "Work order", req.user.username]
  );
  if (req.body.featureId) {
    const feature = await pool.query("SELECT properties FROM features WHERE id = $1", [Number(req.body.featureId)]);
    if (feature.rowCount) {
      const properties = { ...(feature.rows[0].properties || {}), workorderid: result.rows[0].id };
      await pool.query("UPDATE features SET properties = $2::jsonb WHERE id = $1", [Number(req.body.featureId), JSON.stringify(properties)]);
    }
  }
  res.json(result.rows[0]);
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
    console.log(`Medianet Atlas listening on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
