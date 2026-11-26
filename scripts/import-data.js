import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "../server/db.js";
import { geometryBounds, styleFor, toWgs84Geometry } from "./geo.js";

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data");

function readJson(name) {
  const file = path.join(dataDir, name);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const ID_FIELDS = {
  bdg: "buildingid",
  ap: "access_pointid",
  cab: "cableid",
  sp: "enclosureid",
  tp: "fibermngrid",
  planl: "planlineid",
  planp: "planpointid"
};

function chooseIdField(xType, rows, geometries) {
  if (ID_FIELDS[xType] && rows?.length && Object.prototype.hasOwnProperty.call(rows[0], ID_FIELDS[xType])) {
    return ID_FIELDS[xType];
  }
  if (!rows?.length) return null;
  const ids = new Set((geometries || []).map((feature) => Number(feature.xId)));
  let best = null;
  let bestScore = 0;
  for (const key of Object.keys(rows[0])) {
    if (!/id$/i.test(key)) continue;
    let score = 0;
    for (const row of rows.slice(0, 40)) {
      if (ids.has(Number(row[key]))) score += 1;
    }
    if (score > bestScore) {
      best = key;
      bestScore = score;
    }
  }
  return best;
}

function pointFromGps(properties) {
  const lat = Number(properties.gpslatitude ?? properties.gpsLatitude);
  const lng = Number(properties.gpslongitude ?? properties.gpsLongitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  if (lat === 0 && lng === 0) return null;
  return { type: "Point", coordinates: [lng, lat] };
}

function displayName(xType, properties, fallback) {
  return String(properties.name || properties.xName || fallback || `${xType}`).trim();
}

export async function importData() {
  const geometries = readJson("geometries.json");
  const attributes = readJson("attributes.json") || {};
  const networkJson = readJson("network.json");
  const dictionaries = readJson("dictionaries.json") || {};
  const typeLists = readJson("type-lists.json") || {};
  if (!geometries || !networkJson) {
    console.log("No harvested OSPInsight data found. Map will start with the GPON network only.");
    return { imported: 0 };
  }

  const boundary = toWgs84Geometry(networkJson.xGeo);
  const networkName = networkJson.xName || "GPON";
  const designation = networkJson.designation || "Production";
  const version = networkJson.version || "";
  const existing = await pool.query("SELECT id FROM networks WHERE name = $1 ORDER BY id LIMIT 1", [networkName]);
  let networkId = existing.rows[0]?.id;
  if (networkId) {
    await pool.query(
      "UPDATE networks SET designation = $2, version = $3, boundary = $4::jsonb WHERE id = $1",
      [networkId, designation, version, JSON.stringify(boundary)]
    );
  } else {
    const networkResult = await pool.query(
      `INSERT INTO networks (name, designation, version, boundary)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING id`,
      [networkName, designation, version, JSON.stringify(boundary)]
    );
    networkId = networkResult.rows[0].id;
  }

  const force = process.argv.includes("--force");
  const existingFeatures = await pool.query("SELECT count(*)::int AS count FROM features WHERE network_id = $1", [networkId]);
  if (existingFeatures.rows[0].count > 0 && !force) {
    console.log(`Network already has ${existingFeatures.rows[0].count} features. Import left them in place.`);
    return { imported: 0, networkId };
  }
  await pool.query("DELETE FROM features WHERE network_id = $1", [networkId]);
  await pool.query("DELETE FROM field_defs");
  await pool.query("DELETE FROM catalog_items WHERE network_id = $1", [networkId]);

  const records = [];
  for (const [xType, geometryRows] of Object.entries(geometries)) {
    const rows = attributes[xType] || [];
    const idField = chooseIdField(xType, rows, geometryRows);
    const byId = new Map();
    for (const row of rows) {
      const sourceId = idField ? Number(row[idField]) : null;
      if (sourceId) byId.set(sourceId, row);
    }
    const seen = new Set();
    for (const feature of geometryRows) {
      const properties = { ...(byId.get(Number(feature.xId)) || {}) };
      if (!properties.name && feature.xName) properties.name = feature.xName;
      const geometry = feature.geometry;
      if (!geometry) continue;
      seen.add(Number(feature.xId));
      const bounds = geometryBounds(geometry);
      if (!bounds) continue;
      records.push({
        networkId,
        xType,
        sourceId: Number(feature.xId),
        name: displayName(xType, properties, feature.xName),
        geometry,
        properties,
        style: styleFor(xType, properties),
        ...bounds
      });
    }
    for (const [sourceId, properties] of byId) {
      if (seen.has(sourceId)) continue;
      const geometry = pointFromGps(properties);
      if (!geometry) continue;
      const bounds = geometryBounds(geometry);
      records.push({
        networkId,
        xType,
        sourceId,
        name: displayName(xType, properties, ""),
        geometry,
        properties,
        style: styleFor(xType, properties),
        ...bounds
      });
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchSize = 80;
    for (let index = 0; index < records.length; index += batchSize) {
      const batch = records.slice(index, index + batchSize);
      const values = [];
      const placeholders = batch.map((row, rowIndex) => {
        const base = rowIndex * 13;
        values.push(
          row.networkId, row.xType, row.sourceId, row.name,
          JSON.stringify(row.geometry), JSON.stringify(row.properties), JSON.stringify(row.style),
          row.minLng, row.minLat, row.maxLng, row.maxLat, row.centroidLng, row.centroidLat
        );
        const slots = Array.from({ length: 13 }, (_, slot) => `$${base + slot + 1}`);
        slots[4] += "::jsonb";
        slots[5] += "::jsonb";
        slots[6] += "::jsonb";
        return `(${slots.join(",")})`;
      });
      await client.query(
        `INSERT INTO features (
          network_id, x_type, source_id, name, geometry, properties, style,
          min_lng, min_lat, max_lng, max_lat, centroid_lng, centroid_lat
        ) VALUES ${placeholders.join(",")}`,
        values
      );
    }

    for (const [xType, fields] of Object.entries(dictionaries)) {
      if (!Array.isArray(fields)) continue;
      for (const field of fields) {
        if (!field.fieldname || !field.caption) continue;
        await client.query(
          `INSERT INTO field_defs (x_type, fieldname, caption, fieldorder, visible, required)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (x_type, fieldname) DO UPDATE
           SET caption = EXCLUDED.caption, fieldorder = EXCLUDED.fieldorder,
               visible = EXCLUDED.visible, required = EXCLUDED.required`,
          [xType, field.fieldname, field.caption, field.fieldorder || 0, Boolean(field.visible), Boolean(field.required)]
        );
      }
    }

    const typeNames = {
      bdgt: "Building Type",
      apt: "Access Point Type",
      spt: "Splice Point Type",
      tpt: "Term Point Type",
      spant: "Span Type",
      devicetype: "PON Splitter Type"
    };
    let typeCount = 0;
    for (const [objectType, rows] of Object.entries(typeLists)) {
      for (const row of rows || []) {
        const name = row.name || row.xname || row.xName;
        if (!name) continue;
        typeCount += 1;
        await client.query(
          `INSERT INTO catalog_items (network_id, category, object_type, name, properties)
           VALUES ($1, 'default_type', $2, $3, $4::jsonb)`,
          [networkId, typeNames[objectType] || objectType, name, JSON.stringify(row)]
        );
      }
    }
    if (!typeCount) {
      const defaults = [
        ["Access Point Type", "288 Cabinet - 288 cabinet - 288C"],
        ["Building Type", "Building - Residential"],
        ["PON Splitter Type", "1x8 Splitter - Sun telecom - none"],
        ["Span Type", "12C-Sun telecom - none - 12"],
        ["Splice Point Type", "48C - Gelink - none"],
        ["Term Point Type", "24C - Gelink - none"]
      ];
      for (const [objectType, name] of defaults) {
        await client.query(
          `INSERT INTO catalog_items (network_id, category, object_type, name, properties)
           VALUES ($1, 'default_type', $2, $3, '{}'::jsonb)`,
          [networkId, objectType, name]
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(`Imported ${records.length} features into network ${networkId}`);
  return { imported: records.length, networkId };
}

if (process.argv[1] && process.argv[1].endsWith("import-data.js")) {
  importData()
    .then(() => pool.end())
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
