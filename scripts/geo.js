const ORIGIN = 20037508.342789244;

export function mercatorToLngLat(x, y) {
  const lng = (x / ORIGIN) * 180;
  const lat = (Math.atan(Math.sinh((y / ORIGIN) * Math.PI)) * 180) / Math.PI;
  return [lng, lat];
}

export function looksLikeMercator(geometry) {
  const pair = firstPair(geometry && geometry.coordinates);
  if (!pair) return false;
  return Math.abs(pair[0]) > 180 || Math.abs(pair[1]) > 90;
}

function firstPair(coords) {
  if (!Array.isArray(coords)) return null;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") return coords;
  return firstPair(coords[0]);
}

export function toWgs84Geometry(geometry) {
  if (!geometry) return null;
  if (!looksLikeMercator(geometry)) return geometry;
  if (geometry.type === "GeometryCollection") {
    return {
      type: "GeometryCollection",
      geometries: (geometry.geometries || []).map(toWgs84Geometry).filter(Boolean)
    };
  }
  return {
    type: geometry.type,
    coordinates: convertCoords(geometry.coordinates)
  };
}

function convertCoords(coords) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    return mercatorToLngLat(coords[0], coords[1]);
  }
  return coords.map(convertCoords);
}

export function geometryBounds(geometry) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  let count = 0;
  let sumLng = 0;
  let sumLat = 0;
  walk(geometry && geometry.coordinates, (lng, lat) => {
    minLng = Math.min(minLng, lng);
    minLat = Math.min(minLat, lat);
    maxLng = Math.max(maxLng, lng);
    maxLat = Math.max(maxLat, lat);
    sumLng += lng;
    sumLat += lat;
    count += 1;
  });
  if (!count) return null;
  return {
    minLng, minLat, maxLng, maxLat,
    centroidLng: sumLng / count,
    centroidLat: sumLat / count
  };
}

function walk(coords, visit) {
  if (!Array.isArray(coords)) return;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    visit(coords[0], coords[1]);
    return;
  }
  coords.forEach((part) => walk(part, visit));
}

function miColor(colorNumber) {
  const n = Number(colorNumber);
  if (!Number.isFinite(n) || n < 0) return "#000000";
  const r = n & 255;
  const g = (n >> 8) & 255;
  const b = (n >> 16) & 255;
  return "#" + [r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("");
}

export function parseMiStyle(value) {
  if (!value || typeof value !== "string") return null;
  const pen = value.match(/Pen\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*(-?\d+)\s*\)/i);
  const brush = value.match(/Brush\s*\(\s*([\d.]+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)/i);
  if (!pen && !brush) return null;
  const style = {};
  if (pen) {
    style.weight = Number(pen[1]) || 1;
    style.stroke = miColor(pen[3]);
  }
  if (brush) {
    style.fill = miColor(brush[2]);
    style.kind = "polygon";
  } else {
    style.kind = "line";
  }
  return style;
}

export function parseOspStyle(value) {
  if (!value) return null;
  const parts = Array.isArray(value) ? value : String(value).split(",");
  if (!parts.length) return null;
  const kind = parts[0];
  if (kind === "L" && parts[1]) {
    return { kind: "line", stroke: normalizeColor(parts[1]), weight: Number(parts[2]) || 2 };
  }
  if (kind === "P" && parts[1]) {
    return {
      kind: "polygon",
      fill: normalizeColor(parts[1]),
      stroke: normalizeColor(parts[2] || parts[1]),
      weight: Number(parts[3]) || 1,
      dash: Boolean(parts[4])
    };
  }
  return null;
}

export function normalizeColor(value) {
  if (!value) return "#000000";
  let color = String(value).trim();
  if (/^#[0-9a-fA-F]{8}$/.test(color)) color = color.slice(0, 7);
  return color;
}

export const DEFAULT_STYLES = {
  bdg: { kind: "polygon", fill: "#E0E0E0", stroke: "#800080", weight: 2 },
  cab: { kind: "line", stroke: "#0B5394", weight: 2 },
  ap: { kind: "polygon", fill: "#701C00", stroke: "#701C00", weight: 2 },
  sp: { kind: "polygon", fill: "#FFFF00", stroke: "#000000", weight: 1 },
  tp: { kind: "polygon", fill: "#E69138", stroke: "#000000", weight: 1, dash: true },
  planl: { kind: "line", stroke: "#FF0000", weight: 2 },
  planp: { kind: "point", fill: "#FF0000", stroke: "#000000", weight: 1 },
  pole: { kind: "point", fill: "#6E6E6E", stroke: "#202020", weight: 1 },
  sla: { kind: "point", fill: "#66cdaa", stroke: "#0b6e56", weight: 1 },
  db: { kind: "line", stroke: "#808080", weight: 3, dash: true },
  pln: { kind: "line", stroke: "#202020", weight: 1 }
};

export function styleFor(xType, properties) {
  const base = { ...(DEFAULT_STYLES[xType] || { kind: "point", fill: "#2020FF", stroke: "#000000", weight: 1 }) };
  const overlay = parseOspStyle(properties && properties.ospstyle) || parseMiStyle(properties && properties.mi_style) || {};
  const merged = { ...base, ...overlay };
  if (!merged.fill) merged.fill = base.fill;
  if (xType === "sp") {
    merged.fill = "#FFFF00";
    merged.stroke = "#000000";
    merged.kind = "point";
    merged.weight = 1;
  }
  return merged;
}
