import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { toWgs84Geometry } from "./geo.js";

dotenv.config();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.join(root, "data");
const base = (process.env.OSP_BASE_URL || "http://103.84.132.26").replace(/\/$/, "");
const clientId = process.env.OSP_CLIENT_ID;
const clientSecret = process.env.OSP_CLIENT_SECRET;

fs.mkdirSync(dataDir, { recursive: true });

const jar = new Map();

function storeCookies(response) {
  const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const cookie of list) {
    const pair = cookie.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function request(url, options = {}, hops = 0) {
  const response = await fetch(url, {
    ...options,
    redirect: "manual",
    headers: { ...(options.headers || {}), cookie: cookieHeader() }
  });
  storeCookies(response);
  if ([301, 302, 303, 307, 308].includes(response.status) && hops < 5) {
    const location = response.headers.get("location");
    const next = new URL(location, url).href;
    return request(next, { method: "GET" }, hops + 1);
  }
  return response;
}

async function login() {
  jar.clear();
  const authorize = `${base}/ospauth/OAuth/Authorize?scope=afo&client_id=${clientId}&redirect_uri=none&response_type=code`;
  await request(authorize);
  const form = new URLSearchParams({ login: process.env.OSP_USER || "", password: process.env.OSP_PASSWORD || "" });
  const auth = await request(`${base}/OSPAuth/OAuth/Authenticate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form
  });
  const html = await auth.text();
  const match = html.match(/CODE='([^']+)'/);
  if (!match || match[1] === "notauthorized") {
    throw new Error(`OSPInsight login failed (${auth.status})`);
  }
  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code: match[1],
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: "none"
  });
  const tokenResponse = await fetch(`${base}/ospauth/Ws/Token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: tokenBody
  });
  const tokenJson = await tokenResponse.json();
  if (!tokenJson.successful || !tokenJson.data?.access_token) {
    throw new Error("Token exchange failed");
  }
  return tokenJson.data.access_token;
}

let accessToken = await login();

async function api(pathname, body, attempt = 0) {
  const response = await fetch(base + pathname, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await response.json();
  if (!json.successful) {
    const message = String(json.data || json.msg || "request failed");
    if (attempt < 1 && /token|unauthorized|session/i.test(message)) {
      accessToken = await login();
      return api(pathname, body, attempt + 1);
    }
    throw new Error(`${pathname} ${message.slice(0, 180)}`);
  }
  return json.data;
}

function featuresFromMapData(data) {
  if (Array.isArray(data)) {
    return data.map((item) => ({
      xType: item.xType,
      xId: Number(item.xId),
      xName: item.xName || "",
      geometry: toWgs84Geometry(item.xGeo)
    }));
  }
  if (data && Array.isArray(data.features)) {
    return data.features.map((feature) => {
      const id = String(feature.id || "");
      const [xType, xId] = id.split(".");
      const xObject = feature.properties && feature.properties.xObject;
      return {
        xType: xType || xObject?.xType,
        xId: Number(xId || xObject?.xId),
        xName: xObject?.xName || feature.properties?.name || "",
        geometry: toWgs84Geometry(feature.geometry)
      };
    }).filter((feature) => feature.xType && feature.xId);
  }
  return [];
}

function rectangle(minX, minY, maxX, maxY) {
  return {
    type: "Polygon",
    coordinates: [[[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]]]
  };
}

async function collectLayer(layer, bbox) {
  const found = new Map();
  let requests = 0;
  async function walk(minX, minY, maxX, maxY, depth) {
    requests += 1;
    const data = await api("/web9/Ws/getMapData", {
      networkId: 1,
      layer,
      boundsGeo: rectangle(minX, minY, maxX, maxY),
      render: 1,
      showCompletedFieldNotes: 0,
      includeInsidePlant: true
    });
    const features = featuresFromMapData(data);
    const width = maxX - minX;
    const height = maxY - minY;
    if (features.length >= 500 && depth < 14 && width > 15 && height > 15) {
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      await walk(minX, minY, midX, midY, depth + 1);
      await walk(midX, minY, maxX, midY, depth + 1);
      await walk(minX, midY, midX, maxY, depth + 1);
      await walk(midX, midY, maxX, maxY, depth + 1);
      return;
    }
    for (const feature of features) found.set(`${feature.xType}:${feature.xId}`, feature);
  }
  await walk(bbox[0], bbox[1], bbox[2], bbox[3], 0);
  console.log(`${layer}: ${found.size} geometries in ${requests} requests`);
  return [...found.values()];
}

async function searchAll(xType, field) {
  const rows = [];
  const limit = 200;
  let offset = 0;
  let total = Infinity;
  while (offset < total) {
    let data;
    try {
      data = await api("/web9/Ws/search", {
        cmd: "get",
        limit,
        offset,
        searchLogic: "AND",
        search: [{ field, type: "text", operator: "contains", value: "", values: [""] }],
        networkId: 1,
        multiple: false,
        xType
      });
    } catch (error) {
      console.log(`${xType} search skipped: ${error.message}`);
      return rows;
    }
    total = Number(data.total || 0);
    const batch = data.results || [];
    rows.push(...batch);
    offset += batch.length;
    if (!batch.length) break;
    if (offset % 1000 === 0) console.log(`${xType} attributes ${offset}/${total}`);
  }
  console.log(`${xType}: ${rows.length} attribute rows`);
  return rows;
}

const network = await api("/web9/Ws/openNtk/1");
fs.writeFileSync(path.join(dataDir, "network.json"), JSON.stringify(network));
const bbox = network.xGeo.bbox;

const layers = ["bdg", "ap", "cab", "sp", "tp", "planl", "planp", "pole", "sla", "db", "pln"];
const geometries = {};
for (const layer of layers) {
  try {
    geometries[layer] = await collectLayer(layer, bbox);
  } catch (error) {
    console.log(`${layer} geometry skipped: ${error.message}`);
    geometries[layer] = [];
  }
}
fs.writeFileSync(path.join(dataDir, "geometries.json"), JSON.stringify(geometries));

const attributePlan = [
  ["bdg", "name"],
  ["ap", "name"],
  ["sp", "name"],
  ["tp", "name"],
  ["cab", "cableid"],
  ["planl", "name"],
  ["planp", "name"]
];
const attributes = {};
for (const [xType, field] of attributePlan) {
  attributes[xType] = await searchAll(xType, field);
}
fs.writeFileSync(path.join(dataDir, "attributes.json"), JSON.stringify(attributes));

const dictionaries = {};
for (const xType of ["bdg", "ap", "cab", "sp", "tp", "planl", "planp"]) {
  try {
    dictionaries[xType] = await api(`/web9/Ws/getOSPDictionary/1/${xType}`);
  } catch (error) {
    console.log(`dictionary ${xType}: ${error.message}`);
  }
}
fs.writeFileSync(path.join(dataDir, "dictionaries.json"), JSON.stringify(dictionaries));

const typeLists = {};
for (const xType of ["bdgt", "apt", "spt", "tpt", "spant", "devicetype"]) {
  typeLists[xType] = await searchAll(xType, "name");
}
fs.writeFileSync(path.join(dataDir, "type-lists.json"), JSON.stringify(typeLists));

const summary = {};
for (const [key, value] of Object.entries(geometries)) summary[key] = { geometries: value.length, attributes: (attributes[key] || []).length };
console.log(JSON.stringify(summary, null, 2));
