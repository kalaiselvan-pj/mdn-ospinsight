const DRAW_KIND = {
  bdg: "polygon", cab: "line", db: "line", pln: "line", planl: "line",
  ap: "square", sp: "point", tp: "square", pole: "point", sla: "point", planp: "point"
};

const state = {
  token: sessionStorage.getItem("osp_token") || "",
  user: null,
  networks: [],
  network: null,
  fieldDefs: [],
  catalog: [],
  styles: {},
  visible: {},
  counts: [],
  bookmarks: [],
  map: null,
  boundary: null,
  layer: null,
  layerFeatures: [],
  editOverlay: null,
  editingId: null,
  selectedId: null,
  drawMode: "select",
  createParent: null,
  clickMark: null,
  draft: [],
  preview: null,
  history: [],
  future: [],
  movingHistory: false
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: state.token ? `Bearer ${state.token}` : "",
      ...(options.headers || {})
    }
  });
  if (response.status === 401) {
    state.token = "";
    sessionStorage.removeItem("osp_token");
    showLogin("Please sign in");
    throw new Error("Please sign in");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showLogin(message) {
  $("app").hidden = true;
  $("login-screen").hidden = false;
  $("login-error").textContent = message || "";
}

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    const result = await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ username: $("login-user").value, password: $("login-pass").value })
    });
    state.token = result.token;
    sessionStorage.setItem("osp_token", result.token);
    await boot();
  } catch (error) {
    $("login-error").textContent = error.message;
  }
});

async function boot() {
  const data = await api("/api/bootstrap");
  state.user = data.user;
  state.networks = data.networks;
  state.network = data.networks[0];
  state.fieldDefs = data.fieldDefs;
  state.catalog = data.catalog;
  state.styles = data.defaultStyles;
  state.counts = data.counts || [];
  state.bookmarks = data.bookmarks.filter((item) => item.network_id === state.network.id);
  state.settings = data.settings || {};
  for (const key of Object.keys(data.typeLabels)) state.visible[key] = true;
  $("user-label").textContent = data.user.displayName || data.user.username;
  $("network-badge").textContent = state.network.name;
  $("login-screen").hidden = true;
  $("app").hidden = false;
  renderSidebar();
  if (!window.google?.maps) await loadGoogle(data.googleMapsKey);
  initMap();
}

function loadGoogle(key) {
  return new Promise((resolve, reject) => {
    if (!key) {
      reject(new Error("Google Maps API key is missing"));
      return;
    }
    window.__ospMapReady = () => resolve();
    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&callback=__ospMapReady`;
    script.async = true;
    script.onerror = () => reject(new Error("Google Maps could not be loaded. Check the API key restrictions."));
    document.head.appendChild(script);
  });
}

function renderSidebar() {
  const types = state.catalog.filter((item) => item.category === "default_type");
  const grouped = new Map();
  for (const item of types) {
    if (!grouped.has(item.object_type)) grouped.set(item.object_type, []);
    grouped.get(item.object_type).push(item.name);
  }
  $("type-list").innerHTML = grouped.size
    ? [...grouped.entries()].map(([type, names]) => `<button type="button" data-open-types="${escapeHtml(type)}">${navIcon(iconForLabel(type))}${escapeHtml(type)} <span class="muted">${escapeHtml(names[0])}</span></button>`).join("")
    : `<button type="button" data-open-types="Building Type">${navIcon("bdg")}Building Type</button>`;
  const attributeTypes = ["Building", "Cable", "Access Point", "Splice Point", "Term Point", "Pole", "Slack", "Duct Bank", "Aerial Strand"];
  $("attribute-list").innerHTML = attributeTypes.map((name) => `<button type="button" data-attributes="${escapeHtml(name)}">${navIcon(iconForLabel(name))}${escapeHtml(name)}</button>`).join("");
  $("theme-list").innerHTML = Object.keys(state.styles).map((key) => `<button type="button" data-theme="${key}">${navIcon(key)}${label(key)}</button>`).join("");
  $("network-list").innerHTML = state.networks.map((network) => `<button type="button" data-network="${network.id}">${navIcon("network")}${escapeHtml(network.name)} <span class="muted">${escapeHtml(network.designation || "")}</span></button>`).join("");
  renderLegend();
}

function navIcon(kind) {
  return `<span class="mi mi-${escapeHtml(kind || "type")}"></span>`;
}

function iconForLabel(text) {
  const key = String(text || "").toLowerCase();
  if (key.includes("building") || key === "bdg") return "bdg";
  if (key.includes("span") || key.includes("cable") || key === "cab") return "cab";
  if (key.includes("access") || key === "ap") return "ap";
  if (key.includes("splice") || key === "sp") return "sp";
  if (key.includes("term") || key === "tp") return "tp";
  if (key.includes("pole")) return "pole";
  if (key.includes("slack") || key === "sla") return "sla";
  if (key.includes("duct") || key === "db") return "db";
  if (key.includes("aerial") || key.includes("strand") || key === "pln") return "pln";
  if (key.includes("plan line") || key === "planl") return "planl";
  if (key.includes("plan point") || key === "planp") return "planp";
  if (key.includes("splitter")) return "split";
  if (key.includes("patch")) return "patch";
  if (key.includes("rack") || key.includes("room")) return "rack";
  return "type";
}

function label(xType) {
  return ({
    bdg: "Building", cab: "Cable", ap: "Access Point", sp: "Splice Point", tp: "Term Point",
    planl: "Plan Line", planp: "Plan Point", pole: "Pole", sla: "Slack", db: "Duct Bank", pln: "Aerial Strand"
  })[xType] || xType;
}

function initMap() {
  const bounds = boundsOf(state.network.boundary);
  state.map = new google.maps.Map($("map"), {
    center: bounds ? bounds.getCenter() : { lat: 4.21, lng: 73.54 },
    zoom: 13,
    mapTypeId: state.settings.mapType || "roadmap",
    disableDefaultUI: true,
    scaleControl: true,
    clickableIcons: false,
    gestureHandling: "greedy"
  });
  if (bounds) state.map.fitBounds(bounds);
  drawBoundary();
  let loadTimer = 0;
  state.map.addListener("idle", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadFeatures, 160);
    updateBoundary();
  });
  state.map.addListener("zoom_changed", () => {
    $("zoom-level").textContent = Math.round(state.map.getZoom());
    updateBoundary();
  });
  state.map.addListener("mousemove", (event) => {
    $("coords").textContent = `${event.latLng.lat().toFixed(6)}, ${event.latLng.lng().toFixed(6)}`;
  });
  state.map.addListener("click", async (event) => {
    hideMenu();
    if (state.drawMode !== "select") {
      addDraftPoint(event.latLng);
      return;
    }
    const hits = await objectsAt(event.latLng);
    if (!hits.length) return;
    state.selectedId = hits[0].id;
    refreshNetwork();
  });
  state.map.addListener("dblclick", (event) => {
    if (state.drawMode === "select") return;
    event.stop();
    finishDraft();
  });
  state.map.addListener("rightclick", async (event) => {
    markClick(event.latLng);
    const hits = state.drawMode === "select" ? await objectsAt(event.latLng) : [];
    if (hits[0]) {
      state.selectedId = preferObject(hits).id;
      refreshNetwork();
    }
    openMenu(event.domEvent, hits, event.latLng);
  });
  rememberView();
  state.map.addListener("idle", rememberView);
}

function boundsOf(geometry) {
  if (!geometry) return null;
  const bounds = new google.maps.LatLngBounds();
  let any = false;
  walkCoords(geometry.coordinates || geometry.geometries, (lng, lat) => {
    bounds.extend({ lng, lat });
    any = true;
  });
  return any ? bounds : null;
}

function walkCoords(coords, visit) {
  if (!coords) return;
  if (Array.isArray(coords) && typeof coords[0] === "number") {
    visit(coords[0], coords[1]);
    return;
  }
  if (Array.isArray(coords)) coords.forEach((part) => walkCoords(part.coordinates || part, visit));
}

function drawBoundary() {
  if (state.boundary) state.boundary.setMap(null);
  const geometry = state.network.boundary;
  if (!geometry || geometry.type !== "Polygon") return;
  state.boundary = new google.maps.Polygon({
    map: state.map,
    paths: ringsToPaths(geometry.coordinates),
    strokeColor: "#1f9d45",
    strokeWeight: 2,
    fillOpacity: 0,
    clickable: false,
    zIndex: 1
  });
  updateBoundary();
}

function updateBoundary() {
  if (!state.boundary || !state.map) return;
  state.boundary.setVisible(state.map.getZoom() < 12);
}

const DRAW_RANK = { bdg: 0, db: 1, pln: 2, planl: 2, cab: 3, pole: 4, sla: 4, ap: 5, tp: 6, sp: 7, planp: 7 };
let loadSeq = 0;

async function loadFeatures() {
  if (!state.map || !state.network) return;
  const bounds = state.map.getBounds();
  if (!bounds) return;
  const seq = ++loadSeq;
  const ne = bounds.getNorthEast();
  const sw = bounds.getSouthWest();
  const types = Object.entries(state.visible).filter(([, on]) => on).map(([key]) => key).join(",");
  const zoom = Math.round(state.map.getZoom());
  const countOnly = zoom < 15 ? "&countOnly=1" : "";
  try {
    const data = await api(`/api/features?networkId=${state.network.id}&west=${sw.lng()}&south=${sw.lat()}&east=${ne.lng()}&north=${ne.lat()}&zoom=${zoom}&types=${encodeURIComponent(types)}${countOnly}`);
    if (seq !== loadSeq) return;
    const features = (data.features || []).slice().sort((a, b) => (DRAW_RANK[a.xType] ?? 4) - (DRAW_RANK[b.xType] ?? 4));
    const layerKey = features.map((feature) => feature.id).join(",");
    if (layerKey !== state.layerKey) {
      state.layerFeatures = features;
      state.layerKey = layerKey;
      state.layerStamp = (state.layerStamp || 0) + 1;
    }
    refreshNetwork();
    $("scale-label").textContent = zoom < 15
      ? `${data.total} features. Zoom to 15 or closer to draw buildings, splices and cables.`
      : `${state.layerFeatures.length} shown`;
  } catch (error) {
    if (error.message === "Please sign in") return;
    $("scale-label").textContent = "Could not load the map layer";
  }
}

function worldPoint(lat, lng) {
  const clamped = Math.max(-85, Math.min(85, lat));
  const sin = Math.sin(clamped * Math.PI / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)
  };
}

function clearGround() {
  if (state.ground) state.ground.setMap(null);
  state.ground = null;
  state.groundBounds = null;
  state.groundZoom = null;
}

function refreshNetwork() {
  const map = state.map;
  if (!map || !map.getBounds()) return;
  const zoom = map.getZoom();
  const view = map.getBounds();
  const stamp = `${state.layerStamp || 0}:${state.selectedId || 0}:${state.editingId || 0}`;
  if (zoom < 15 || !state.layerFeatures.length) {
    clearGround();
    state.groundStamp = stamp;
    return;
  }
  if (state.ground && state.groundStamp === stamp && state.groundBounds && Math.abs((state.groundZoom || 0) - zoom) < 0.05 && state.groundBounds.contains(view.getNorthEast()) && state.groundBounds.contains(view.getSouthWest())) return;
  const southWest = view.getSouthWest();
  const northEast = view.getNorthEast();
  const pad = zoom >= 19 ? 0.04 : zoom >= 17 ? 0.08 : 0.12;
  const latPad = (northEast.lat() - southWest.lat()) * pad;
  const lngPad = (northEast.lng() - southWest.lng()) * pad;
  const bounds = new google.maps.LatLngBounds(
    { lat: southWest.lat() - latPad, lng: southWest.lng() - lngPad },
    { lat: northEast.lat() + latPad, lng: northEast.lng() + lngPad }
  );
  const west = bounds.getSouthWest().lng();
  const east = bounds.getNorthEast().lng();
  const north = worldPoint(bounds.getNorthEast().lat(), west);
  const south = worldPoint(bounds.getSouthWest().lat(), west);
  const pixels = 256 * Math.pow(2, zoom);
  let width = Math.abs(east - west) / 360 * pixels;
  let height = Math.abs(south.y - north.y) * pixels;
  const longest = Math.max(width, height, 1);
  const cap = zoom >= 20 ? 4200 : zoom >= 18 ? 3200 : 2400;
  const limit = longest > cap ? cap / longest : 1;
  width = Math.max(2, Math.round(width * limit));
  height = Math.max(2, Math.round(height * limit));
  const canvas = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const project = (lat, lng) => {
    const point = worldPoint(lat, lng);
    return {
      x: (lng - west) / (east - west) * width,
      y: (point.y - north.y) / (south.y - north.y) * height
    };
  };
  for (const feature of state.layerFeatures) {
    if (feature.id === state.editingId) continue;
    const type = feature.geometry && feature.geometry.type;
    if (["sp", "ap", "tp", "pole", "sla", "planp"].includes(feature.xType) && feature.centroid) {
      paintSymbol(ctx, feature, project, limit);
    } else if (type === "Point") {
      paintSymbol(ctx, feature, project, limit);
    } else if (type === "Polygon" || type === "MultiPolygon") {
      paintPolygon(ctx, feature, project, limit);
    } else if (type === "LineString" || type === "MultiLineString") {
      paintLine(ctx, feature, project, limit);
    }
  }
  if (state.settings && state.settings.showLabels && zoom >= 18) paintLabels(ctx, project);
  const previous = state.ground;
  const overlay = new google.maps.GroundOverlay(canvas.toDataURL("image/png"), bounds, { clickable: false });
  overlay.setMap(map);
  state.ground = overlay;
  state.groundBounds = bounds;
  state.groundZoom = zoom;
  state.groundStamp = stamp;
  if (previous) previous.setMap(null);
}

function paintPolygon(ctx, feature, project, limit = 1) {
  const geometry = feature.geometry;
  const rings = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const style = themedStyle(feature);
  const selected = feature.id === state.selectedId;
  ctx.beginPath();
  for (const polygon of rings) {
    for (const ring of polygon) addRing(ctx, ring, project);
  }
  ctx.fillStyle = hexToRgba(style.fill || "#E0E0E0", selected ? 0.96 : 0.9);
  ctx.fill("evenodd");
  ctx.lineWidth = Math.max(0.7, ((style.weight || 2) + (selected ? 1 : 0)) * limit);
  ctx.strokeStyle = style.stroke || "#800080";
  ctx.setLineDash(style.dash ? [6, 5] : []);
  ctx.stroke();
}

function paintSymbol(ctx, feature, project, limit = 1) {
  const style = themedStyle(feature);
  const selected = feature.id === state.selectedId;
  const zoom = state.map.getZoom();
  const at = feature.centroid
    || (feature.geometry?.type === "Point"
      ? { lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] }
      : null);
  if (!at) return;
  const pixel = project(at.lat, at.lng);
  const screen = feature.xType === "sp"
    ? (zoom >= 20 ? 6 : zoom >= 18 ? 5 : zoom >= 16 ? 4 : 3)
    : (zoom >= 20 ? 8 : zoom >= 18 ? 7 : 5);
  const radius = (selected ? 1.5 : 0) + screen / Math.max(limit, 0.25);
  ctx.setLineDash(style.dash ? [4, 3] : []);
  ctx.beginPath();
  if (feature.xType === "ap") {
    ctx.rect(pixel.x - radius, pixel.y - radius, radius * 2, radius * 2);
  } else if (feature.xType === "tp") {
    ctx.moveTo(pixel.x, pixel.y - radius);
    ctx.lineTo(pixel.x + radius, pixel.y);
    ctx.lineTo(pixel.x, pixel.y + radius);
    ctx.lineTo(pixel.x - radius, pixel.y);
    ctx.closePath();
  } else {
    ctx.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
  }
  ctx.fillStyle = hexToRgba(style.fill || style.stroke || "#FFFF00", 1);
  ctx.fill();
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeStyle = style.stroke || "#000000";
  ctx.stroke();
  ctx.setLineDash([]);
}

function paintLine(ctx, feature, project, limit = 1) {
  const geometry = feature.geometry;
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  const style = themedStyle(feature);
  const selected = feature.id === state.selectedId;
  ctx.beginPath();
  for (const line of lines) addRing(ctx, line, project);
  ctx.lineWidth = Math.max(0.8, ((style.weight || 2) + (selected ? 1 : 0)) * Math.max(limit, 0.35));
  ctx.strokeStyle = style.stroke || "#0B5394";
  ctx.setLineDash(style.dash ? [6, 5] : []);
  ctx.stroke();
}

function addRing(ctx, ring, project) {
  if (!ring || ring.length < 2) return;
  for (let i = 0; i < ring.length; i += 1) {
    const point = project(ring[i][1], ring[i][0]);
    if (i === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  }
}

function paintLabels(ctx, project) {
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.setLineDash([]);
  let count = 0;
  for (const feature of state.layerFeatures) {
    if (!feature.name || !feature.centroid || count >= 40) continue;
    const pixel = project(feature.centroid.lat, feature.centroid.lng);
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(feature.name, pixel.x, pixel.y);
    ctx.fillStyle = "#202020";
    ctx.fillText(feature.name, pixel.x, pixel.y);
    count += 1;
  }
}

function hexToRgba(hex, alpha) {
  const raw = String(hex || "#E0E0E0").replace("#", "");
  const full = raw.length === 3 ? raw.split("").map((part) => part + part).join("") : raw;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return `rgba(224,224,224,${alpha})`;
  return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
}

function hitFeature(latLng) {
  return hitFeatures(latLng)[0] || null;
}

function hitFeatures(latLng) {
  const lat = latLng.lat();
  const lng = latLng.lng();
  const zoom = state.map.getZoom();
  const threshold = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom) * 7;
  const hits = [];
  for (const feature of state.layerFeatures) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      if (geometryContains(lng, lat, geometry)) hits.push(feature);
      else if (["ap", "sp", "tp"].includes(feature.xType) && feature.centroid) {
        const cos = Math.cos(lat * Math.PI / 180);
        const dist = Math.hypot((lng - feature.centroid.lng) * 111320 * cos, (lat - feature.centroid.lat) * 110540);
        if (dist <= threshold * 2.5) hits.push(feature);
      }
    } else if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
      if (lineDistanceMeters(lng, lat, geometry) <= threshold) hits.push(feature);
    } else if (geometry.type === "Point") {
      const [x, y] = geometry.coordinates || [];
      const cos = Math.cos(lat * Math.PI / 180);
      const dist = Math.hypot((lng - x) * 111320 * cos, (lat - y) * 110540);
      if (dist <= threshold) hits.push(feature);
    }
  }
  hits.sort((a, b) => (DRAW_RANK[a.xType] ?? 4) - (DRAW_RANK[b.xType] ?? 4));
  return hits;
}

async function objectsAt(latLng) {
  const local = hitFeatures(latLng);
  const byId = new Map(local.map((feature) => [feature.id, feature]));
  try {
    const remote = await api(`/api/identify?networkId=${state.network.id}&lng=${latLng.lng()}&lat=${latLng.lat()}`);
    for (const item of remote) {
      if (!byId.has(item.id) && state.visible[item.xType] !== false) byId.set(item.id, item);
    }
  } catch (error) {
    if (error.message === "Please sign in") throw error;
  }
  const rank = { sp: 0, cab: 1, ap: 2, tp: 3, bdg: 4, pole: 5, sla: 6 };
  return [...byId.values()].sort((a, b) => (rank[a.xType] ?? 10) - (rank[b.xType] ?? 10) || String(a.name).localeCompare(String(b.name)));
}

function swatch(feature) {
  const style = themedStyle(feature);
  const color = style.fill || style.stroke || "#6fbe44";
  return `<i class="swatch" style="background:${escapeHtml(color)};border-color:${escapeHtml(style.stroke || color)}"></i>`;
}

function geometryContains(lng, lat, geometry) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some((polygon) => pointInRing(lng, lat, polygon[0]));
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

function lineDistanceMeters(lng, lat, geometry) {
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  let best = Infinity;
  const cos = Math.cos(lat * Math.PI / 180);
  const px = lng * 111320 * cos;
  const py = lat * 110540;
  for (const line of lines) {
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

function themedStyle(feature) {
  const theme = state.settings.themes && state.settings.themes[feature.xType];
  const fallback = state.styles[feature.xType] || { stroke: "#2020FF", fill: "#2020FF", weight: 2 };
  let style = { ...fallback, ...(feature.style || {}) };
  if (theme && theme.enabled) style = { ...style, ...theme };
  if (feature.xType === "sp") {
    style.fill = "#FFFF00";
    style.stroke = "#000000";
    style.weight = 1;
  }
  return style;
}

function geometryToOverlay(geometry, style, selected, simplified) {
  const weight = (style.weight || 2) + (selected ? 2 : 0);
  if (!geometry) return null;
  if (geometry.type === "Point" || simplified) {
    const [lng, lat] = geometry.type === "Point" ? geometry.coordinates : [geometry.coordinates[0], geometry.coordinates[1]];
    return new google.maps.Marker({
      position: { lng, lat },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: selected ? 7 : (state.map.getZoom() < 15 ? 2 : 4),
        fillColor: style.fill || style.stroke || "#245",
        fillOpacity: 1,
        strokeColor: style.stroke || "#111",
        strokeWeight: 1
      }
    });
  }
  if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
    const path = geometry.type === "LineString" ? toLatLngs(geometry.coordinates) : geometry.coordinates.flatMap(toLatLngs);
    return new google.maps.Polyline({
      path,
      strokeColor: style.stroke || "#0B5394",
      strokeWeight: weight,
      strokeOpacity: 1,
      icons: style.dash ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, scale: 3 }, offset: "0", repeat: "12px" }] : undefined,
      zIndex: 3
    });
  }
  if (geometry.type === "Polygon") {
    return new google.maps.Polygon({
      paths: ringsToPaths(geometry.coordinates),
      strokeColor: style.stroke || "#800080",
      strokeWeight: weight,
      fillColor: style.fill || "#E0E0E0",
      fillOpacity: selected ? 0.72 : 0.55,
      zIndex: 2
    });
  }
  if (geometry.type === "MultiPolygon") {
    return new google.maps.Polygon({
      paths: geometry.coordinates.flatMap(ringsToPaths),
      strokeColor: style.stroke || "#800080",
      strokeWeight: weight,
      fillColor: style.fill || "#E0E0E0",
      fillOpacity: 0.55,
      zIndex: 2
    });
  }
  return null;
}

function toLatLngs(line) {
  return line.map(([lng, lat]) => ({ lng, lat }));
}

function ringsToPaths(rings) {
  return rings.map((ring) => toLatLngs(ring.slice(0, -1)));
}

function selectFeature(id) {
  state.selectedId = id;
  refreshNetwork();
}

function hideMenu() { $("context-menu").hidden = true; }

function preferObject(hits) {
  const order = ["sp", "cab", "ap", "tp", "bdg", "pole", "sla", "db", "pln", "planl", "planp"];
  return [...hits].sort((a, b) => order.indexOf(a.xType) - order.indexOf(b.xType))[0] || hits[0];
}

function objectIcon(xType) {
  return `<span class="oi oi-${escapeHtml(xType)}"></span>`;
}

function objectLabel(feature) {
  return feature.name || `${feature.typeLabel || label(feature.xType)} ${feature.sourceId || ""}`;
}

function markClick(latLng) {
  if (state.clickMark) state.clickMark.setMap(null);
  if (!latLng || !state.map) return;
  state.clickMark = new google.maps.Circle({
    map: state.map,
    center: latLng,
    radius: 7,
    strokeColor: "#FFFF00",
    strokeWeight: 3,
    fillColor: "#FFFF00",
    fillOpacity: 0.28,
    clickable: false,
    zIndex: 40
  });
}

function openMenu(event, hits, latLng) {
  const host = document.querySelector("main").getBoundingClientRect();
  const menu = $("context-menu");
  const x = event?.clientX ? event.clientX - host.left : 80;
  const y = event?.clientY ? event.clientY - host.top : 80;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const features = Array.isArray(hits) ? hits : hits ? [hits] : [];
  const actions = new Map();
  let actionId = 0;
  const bind = (fn) => {
    actionId += 1;
    const key = String(actionId);
    actions.set(key, fn);
    return key;
  };
  const html = [];
  html.push(`<div class="ctx-section">Map Objects</div>`);
  if (features.length) {
    features.forEach((item, index) => {
      html.push(`<div class="ctx-subwrap">
        <button type="button" class="ctx-object${index === 0 ? " active" : ""}">${objectIcon(item.xType)}${escapeHtml(objectLabel(item))}</button>
        <div class="ctx-sub">${objectSubmenu(item, features, latLng, bind)}</div>
      </div>`);
    });
  } else {
    html.push(`<div class="muted ctx-empty">No map object at this point</div>`);
  }
  html.push(`<div class="ctx-section">Map</div>`);
  html.push(submenu("New Map Object", [
    ["Building", bind(() => startDraw("bdg", latLng))],
    ["Cable", bind(() => startDraw("cab", latLng))],
    ["Access Point", bind(() => startDraw("ap", latLng))],
    ["Splice Point", bind(() => startDraw("sp", latLng))],
    ["Term Point", bind(() => startDraw("tp", latLng))],
    ["Pole", bind(() => startDraw("pole", latLng))],
    ["Slack", bind(() => startDraw("sla", latLng))]
  ].map(([text, key]) => `<button type="button" data-act="${key}">${text}</button>`).join("")));
  html.push(`<button type="button" data-act="${bind(() => geocodePoint(latLng))}">Reverse Geocode</button>`);
  menu.innerHTML = html.join("");
  menu.hidden = false;
  const openLeft = x + 520 > host.width;
  menu.querySelectorAll(".ctx-subwrap").forEach((wrap) => wrap.classList.toggle("open-left", openLeft));
  menu.querySelectorAll("[data-act]").forEach((button) => {
    button.onclick = (clickEvent) => {
      clickEvent.stopPropagation();
      hideMenu();
      actions.get(button.dataset.act)?.();
    };
  });
}

function submenu(title, innerHtml) {
  return `<div class="ctx-subwrap"><button type="button" class="ctx-parent">${escapeHtml(title)}<span class="ctx-caret">▸</span></button><div class="ctx-sub">${innerHtml}</div></div>`;
}

function menuGroup(items) {
  return items.map((item) => {
    if (item === "sep") return `<hr class="ctx-sep">`;
    if (item.sub) return submenu(item.label, menuGroup(item.sub));
    return `<button type="button" data-act="${item.act}">${escapeHtml(item.label)}</button>`;
  }).join("");
}

function objectSubmenu(feature, stack, latLng, bind) {
  const typeName = feature.typeLabel || label(feature.xType);
  const rows = [
    { label: "Show on Map", act: bind(() => showOnMap(feature.id)) },
    "sep",
    { label: "Attributes", act: bind(() => openFeature(feature.id, false, stack, "attributes")) },
    { label: "Relations", act: bind(() => openFeature(feature.id, false, stack, "related")) },
    { label: "Files", act: bind(() => openFiles(feature.id)) },
    "sep",
    { label: "Add to Active Work Order", act: bind(() => addWorkOrder(feature)) }
  ];
  if (["sp", "ap", "tp", "cab"].includes(feature.xType)) {
    rows.splice(6, 0,
      { label: "Splice Key Diagram", act: bind(() => openSpliceView(feature.id, "diagram")) },
      { label: "Splice Key Editor", act: bind(() => openSpliceView(feature.id, "editor")) },
      { label: "Splice List", act: bind(() => openSpliceView(feature.id, "list")) },
      { label: "Splice Spreadsheet", act: bind(() => openSpliceView(feature.id, "sheet")) },
      "sep"
    );
  }
  if (feature.xType === "bdg") {
    rows.push("sep");
    rows.push({ label: "Add Room", act: bind(() => addChildRecord(feature, "Room")) });
    rows.push({ label: "Add Rack", act: bind(() => addChildRecord(feature, "Rack")) });
  }
  if (feature.xType === "cab") {
    rows.push("sep");
    rows.push({ label: "Add Splice Point", act: bind(() => addLinked(feature, "sp", latLng)) });
  }
  rows.push("sep");
  rows.push({ label: "Edit Style", act: bind(() => editFeatureStyle(feature.id)) });
  rows.push({ label: "Edit Shape", act: bind(() => editShape(feature.id)) });
  rows.push({ label: "Move or Resize", act: bind(() => editShape(feature.id)) });
  rows.push("sep");
  rows.push({
    label: `Delete ${typeName}`,
    sub: [{ label: `Delete ${typeName}`, act: bind(() => removeFeature(feature.id)) }]
  });
  return menuGroup(rows);
}

async function openFeature(id, editing, stack = [], tab = "attributes") {
  const feature = await api(`/api/features/${id}`);
  state.selectedId = id;
  refreshNetwork();
  const fields = fieldsFor(feature);
  const related = feature.related || [];
  const others = (stack || []).filter((item) => item.id !== feature.id);
  const title = `Identify — ${feature.typeLabel}: ${feature.name || feature.sourceId || ""}`;
  openPanel(title, `
    <form id="feature-form" class="identify">
      <div class="identify-head">
        ${swatch(feature)}
        <div>
          <strong>${escapeHtml(feature.typeLabel)} ${escapeHtml(feature.sourceId || "")}</strong>
          <div class="muted">${escapeHtml(feature.name || "")}</div>
        </div>
      </div>
      ${others.length ? `<div class="identify-stack">${others.map((item) => `<button type="button" class="stack-item" data-open="${item.id}">${swatch(item)}${escapeHtml(item.typeLabel)} — ${escapeHtml(item.name || item.sourceId || "")}</button>`).join("")}</div>` : ""}
      <div class="identify-tabs">
        <button type="button" data-tab="attributes" class="${tab === "attributes" ? "active" : ""}">Attributes (${fields.length})</button>
        <button type="button" data-tab="related" class="${tab === "related" ? "active" : ""}">Related (${related.length})</button>
        <button type="button" data-tab="location" class="${tab === "location" ? "active" : ""}">Location</button>
      </div>
      <div class="identify-pane" data-pane="attributes" ${tab === "attributes" ? "" : "hidden"}>
        <table class="attr-table">
          <tbody>
            ${fields.map((field) => `
              <tr>
                <th>${escapeHtml(field.caption)}</th>
                <td>${editing
                  ? (String(field.value).length > 80
                    ? `<textarea name="${escapeHtml(field.name)}">${escapeHtml(field.value)}</textarea>`
                    : `<input name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}">`)
                  : escapeHtml(field.value)}</td>
              </tr>`).join("")}
            <tr>
              <th>Stroke</th>
              <td>${editing ? `<input name="styleStroke" type="color" value="${escapeHtml((feature.style && feature.style.stroke) || "#0B5394")}">` : escapeHtml((feature.style && feature.style.stroke) || "")}</td>
            </tr>
            ${feature.style && feature.style.fill ? `<tr><th>Fill</th><td>${editing ? `<input name="styleFill" type="color" value="${escapeHtml(feature.style.fill)}">` : escapeHtml(feature.style.fill)}</td></tr>` : ""}
          </tbody>
        </table>
      </div>
      <div class="identify-pane" data-pane="related" ${tab === "related" ? "" : "hidden"}>
        ${related.length
          ? related.map((item) => `<button type="button" class="related-item" data-open="${item.id}">${swatch(item)}<span><strong>${escapeHtml(item.typeLabel)} — ${escapeHtml(item.name || item.sourceId || "")}</strong><small>${escapeHtml(roleLabel(item.role))} · ID ${escapeHtml(item.sourceId || "")}</small></span></button>`).join("")
          : `<p class="muted">No linked buildings, cables, splices or access points.</p>`}
      </div>
      <div class="identify-pane" data-pane="location" ${tab === "location" ? "" : "hidden"}>
        <table class="attr-table">
          <tbody>
            <tr><th>Latitude</th><td>${feature.centroid?.lat ?? ""}</td></tr>
            <tr><th>Longitude</th><td>${feature.centroid?.lng ?? ""}</td></tr>
            <tr><th>Geometry</th><td>${escapeHtml(feature.geometry?.type || "")}</td></tr>
            <tr><th>Network</th><td>${escapeHtml(state.network?.name || "")}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="panel-actions">
        ${editing ? `<button class="primary" type="submit">Save</button>` : `<button type="button" id="start-edit">Edit</button>`}
        <button type="button" id="shape-edit">Edit shape</button>
        <button type="button" class="danger" id="delete-feature">Delete</button>
      </div>
    </form>`);
  $("delete-feature").onclick = () => removeFeature(id);
  $("shape-edit").onclick = () => editShape(id);
  const edit = $("start-edit");
  if (edit) edit.onclick = () => openFeature(id, true, stack, "attributes");
  $("panel-body").querySelectorAll("[data-tab]").forEach((button) => {
    button.onclick = () => {
      $("panel-body").querySelectorAll("[data-tab]").forEach((item) => item.classList.toggle("active", item === button));
      $("panel-body").querySelectorAll(".identify-pane").forEach((pane) => {
        pane.hidden = pane.dataset.pane !== button.dataset.tab;
      });
    };
  });
  $("panel-body").querySelectorAll("[data-open]").forEach((button) => {
    button.onclick = () => openFeature(Number(button.dataset.open), false, [feature, ...others]);
  });
  $("feature-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const properties = { ...feature.properties };
    for (const field of fields) properties[field.name] = form.get(field.name);
    const style = { ...(feature.style || {}), stroke: form.get("styleStroke") || feature.style?.stroke };
    if (form.get("styleFill")) style.fill = form.get("styleFill");
    await api(`/api/features/${id}`, {
      method: "PUT",
      body: JSON.stringify({ name: properties.name || feature.name, properties, style, geometry: feature.geometry })
    });
    openFeature(id, false, stack);
    loadFeatures();
  };
}

function roleLabel(role) {
  return ({
    buildingid: "Building",
    access_pointid: "Access Point",
    enclosureid: "Splice",
    fibermngrid: "Term Point",
    cableid: "Cable",
    poleid: "Pole",
    location: "Location",
    nearby: "At this location"
  })[role] || role || "Linked";
}

function prettyCaption(name, caption) {
  if (caption && caption !== name) return caption;
  return String(name || "")
    .replace(/_/g, " ")
    .replace(/id$/i, " ID")
    .replace(/\b(gps|ea|clli|osp|mi)\b/gi, (part) => part.toUpperCase())
    .replace(/\b\w/g, (part) => part.toUpperCase());
}

function fieldsFor(feature) {
  const properties = feature.properties || {};
  const defs = state.fieldDefs
    .filter((field) => field.x_type === feature.xType)
    .sort((a, b) => (a.fieldorder || 0) - (b.fieldorder || 0) || String(a.caption).localeCompare(String(b.caption)));
  const seen = new Set();
  const fields = [];
  for (const field of defs) {
    seen.add(field.fieldname);
    fields.push({
      name: field.fieldname,
      caption: prettyCaption(field.fieldname, field.caption),
      value: displayValue(properties[field.fieldname])
    });
  }
  Object.keys(properties).sort().forEach((key) => {
    if (seen.has(key)) return;
    seen.add(key);
    fields.push({
      name: key,
      caption: prettyCaption(key, key),
      value: displayValue(properties[key])
    });
  });
  if (!fields.length) {
    return [
      { name: "name", caption: "Name", value: displayValue(properties.name || feature.name) },
      { name: "comments", caption: "Comments", value: displayValue(properties.comments) }
    ];
  }
  return fields;
}

function displayValue(value) {
  if (value && typeof value === "object") {
    return value.xName || value.name || JSON.stringify(value);
  }
  if (value === null || value === undefined) return "";
  return String(value);
}

function row(caption, name, value, editing, type = "text") {
  const control = editing
    ? (String(value).length > 80
      ? `<textarea name="${name}">${escapeHtml(value)}</textarea>`
      : `<input name="${name}" type="${type}" value="${escapeHtml(value)}">`)
    : `<div>${escapeHtml(value) || "—"}</div>`;
  return `<div class="form-row"><label>${escapeHtml(caption)}</label>${control}</div>`;
}

async function editShape(id) {
  const feature = state.layerFeatures.find((item) => item.id === id) || await api(`/api/features/${id}`);
  if (!feature.geometry || feature.geometry.type === "Point") {
    openPanel("Edit shape", "<p class=\"hint\">This item is a point. Use Edit to change its details.</p>");
    return;
  }
  if (state.map.getZoom() < 17) await zoomToFeature(id);
  if (state.editOverlay) state.editOverlay.setMap(null);
  const overlay = geometryToOverlay(feature.geometry, themedStyle(feature), true, false);
  if (!overlay || !overlay.getPath) {
    openPanel("Edit shape", "<p class=\"hint\">This outline cannot be edited.</p>");
    return;
  }
  overlay.setMap(state.map);
  overlay.setEditable(true);
  state.editOverlay = overlay;
  state.editingId = id;
  refreshNetwork();
  openPanel("Edit shape", `<p class="hint">Drag the points, then save.</p>
    <div class="panel-actions"><button class="primary" id="save-shape" type="button">Save shape</button></div>`);
  $("save-shape").onclick = async () => {
    const geometry = overlayToGeometry(overlay, feature.geometry.type);
    await api(`/api/features/${id}`, { method: "PUT", body: JSON.stringify({ geometry }) });
    overlay.setMap(null);
    state.editOverlay = null;
    state.editingId = null;
    closePanel();
    loadFeatures();
  };
}

function overlayToGeometry(overlay, type) {
  if (overlay.getPath && (type === "LineString" || type === "MultiLineString")) {
    return { type: "LineString", coordinates: pathToCoords(overlay.getPath()) };
  }
  const paths = overlay.getPaths ? overlay.getPaths() : null;
  if (!paths) return null;
  const rings = [];
  for (let i = 0; i < paths.getLength(); i += 1) rings.push(closeRing(pathToCoords(paths.getAt(i))));
  return { type: "Polygon", coordinates: rings };
}

function pathToCoords(path) {
  const coords = [];
  for (let i = 0; i < path.getLength(); i += 1) {
    const point = path.getAt(i);
    coords.push([point.lng(), point.lat()]);
  }
  return coords;
}

function closeRing(coords) {
  if (!coords.length) return coords;
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
  return coords;
}

async function zoomToFeature(id) {
  const feature = await api(`/api/features/${id}`);
  const bounds = boundsOf(feature.geometry);
  if (bounds && feature.geometry.type !== "Point") state.map.fitBounds(bounds);
  else state.map.setCenter(feature.centroid);
  if (state.map.getZoom() < 18) state.map.setZoom(18);
  state.selectedId = id;
}

async function removeFeature(id) {
  if (!confirm("Delete this feature?")) return;
  await api(`/api/features/${id}`, { method: "DELETE" });
  if (state.selectedId === id) state.selectedId = null;
  closePanel();
  loadFeatures();
}

function startDraw(xType, latLng) {
  setDrawMode(xType);
  if (latLng) addDraftPoint(latLng);
}

function toLatLng(value) {
  if (!value) return null;
  if (typeof value.lat === "function" && typeof value.lng === "function") return { lat: value.lat(), lng: value.lng() };
  if (Number.isFinite(Number(value.lat)) && Number.isFinite(Number(value.lng))) return { lat: Number(value.lat), lng: Number(value.lng) };
  return null;
}

function addLinked(parent, xType, latLng) {
  state.createParent = parent;
  const loc = toLatLng(latLng) || (parent?.centroid ? { lat: parent.centroid.lat, lng: parent.centroid.lng } : null);
  const kind = DRAW_KIND[xType];
  if (kind === "line" || kind === "polygon") {
    startDraw(xType, loc ? new google.maps.LatLng(loc.lat, loc.lng) : null);
    return;
  }
  if (!loc) {
    startDraw(xType);
    return;
  }
  const here = new google.maps.LatLng(loc.lat, loc.lng);
  const geometry = kind === "square" ? squareGeometry(here, 6) : { type: "Point", coordinates: [loc.lng, loc.lat] };
  openCreate(xType, geometry, parent);
}

function linkProperties(parent, childType) {
  if (!parent) return {};
  const sourceId = parent.sourceId;
  const props = {};
  if (parent.xType === "bdg") {
    props.buildingid = sourceId;
    if (["sp", "tp", "cab", "ap"].includes(childType)) {
      props.x_table = "building";
      props.x_id = sourceId;
    }
  }
  if (parent.xType === "ap") {
    props.access_pointid = sourceId;
    if (["sp", "tp", "cab"].includes(childType)) {
      props.x_table = "access_point";
      props.x_id = sourceId;
    }
  }
  if (parent.xType === "sp" && childType === "cab") {
    props.x_table = "enclosure";
    props.x_id = sourceId;
  }
  if (parent.xType === "pole") props.poleid = sourceId;
  if (parent.name) props.locationxobject = parent.name;
  return props;
}

function setDrawMode(mode) {
  state.drawMode = mode;
  state.draft = [];
  if (state.preview) state.preview.setMap(null);
  state.preview = null;
  const drawing = mode !== "select";
  state.map.setOptions({ disableDoubleClickZoom: drawing, draggableCursor: drawing ? "crosshair" : null });
}

function addDraftPoint(latLng) {
  const kind = DRAW_KIND[state.drawMode];
  if (kind === "point" || kind === "square") {
    const geometry = kind === "square" ? squareGeometry(latLng, 6) : { type: "Point", coordinates: [latLng.lng(), latLng.lat()] };
    openCreate(state.drawMode, geometry);
    setDrawMode("select");
    return;
  }
  state.draft.push(latLng);
  drawPreview();
}

function drawPreview() {
  if (state.preview) state.preview.setMap(null);
  if (state.draft.length < 1) return;
  const path = state.draft.map((point) => ({ lat: point.lat(), lng: point.lng() }));
  state.preview = new google.maps.Polyline({ map: state.map, path, strokeColor: "#245", strokeWeight: 2 });
}

function finishDraft() {
  const kind = DRAW_KIND[state.drawMode];
  const points = state.draft.map((point) => [point.lng(), point.lat()]);
  if (kind === "line" && points.length < 2) return;
  if (kind === "polygon" && points.length < 3) return;
  const geometry = kind === "line"
    ? { type: "LineString", coordinates: snapLine(points) }
    : { type: "Polygon", coordinates: [closeRing(points)] };
  const xType = state.drawMode;
  setDrawMode("select");
  openCreate(xType, geometry);
}

function snapLine(points) {
  const snapped = points.map((point) => [...point]);
  snapped[0] = snapToFeature(snapped[0]);
  snapped[snapped.length - 1] = snapToFeature(snapped[snapped.length - 1]);
  return snapped;
}

function snapToFeature(point) {
  let best = null;
  let bestDistance = 18;
  for (const feature of state.layerFeatures) {
    if (!["ap", "sp", "tp", "bdg", "pole"].includes(feature.xType)) continue;
    const target = feature.centroid;
    if (!target) continue;
    const meters = distanceMeters(point[1], point[0], target.lat, target.lng);
    if (meters < bestDistance) {
      bestDistance = meters;
      best = [target.lng, target.lat];
    }
  }
  return best || point;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const earth = 6371000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.sqrt(a));
}

function squareGeometry(latLng, meters) {
  const lat = latLng.lat();
  const lng = latLng.lng();
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(lat * Math.PI / 180));
  return {
    type: "Polygon",
    coordinates: [[
      [lng - dLng, lat - dLat], [lng + dLng, lat - dLat], [lng + dLng, lat + dLat],
      [lng - dLng, lat + dLat], [lng - dLng, lat - dLat]
    ]]
  };
}

function openCreate(xType, geometry, parent = state.createParent) {
  const style = { ...(state.styles[xType] || {}) };
  const linked = linkProperties(parent, xType);
  const draft = {
    xType,
    typeLabel: label(xType),
    name: linked.locationxobject ? `${label(xType)} at ${linked.locationxobject}` : "",
    properties: { ...linked, name: linked.locationxobject ? `${label(xType)} at ${linked.locationxobject}` : "" },
    style
  };
  const fields = fieldsFor(draft);
  openPanel(`New ${label(xType)}`, `
    <form id="create-form" class="identify">
      ${parent ? `<p class="hint">Linked to ${escapeHtml(parent.typeLabel || label(parent.xType))} — ${escapeHtml(parent.name || parent.sourceId || "")}</p>` : ""}
      <table class="attr-table">
        <tbody>
          ${fields.map((field) => `
            <tr>
              <th>${escapeHtml(field.caption)}</th>
              <td>${String(field.value).length > 80
                ? `<textarea name="${escapeHtml(field.name)}">${escapeHtml(field.value)}</textarea>`
                : `<input name="${escapeHtml(field.name)}" value="${escapeHtml(field.value)}">`}</td>
            </tr>`).join("")}
          <tr><th>Stroke</th><td><input name="styleStroke" type="color" value="${escapeHtml(style.stroke || "#0B5394")}"></td></tr>
          ${style.fill ? `<tr><th>Fill</th><td><input name="styleFill" type="color" value="${escapeHtml(style.fill)}"></td></tr>` : ""}
        </tbody>
      </table>
      <div class="panel-actions"><button class="primary" type="submit">Create</button></div>
    </form>`);
  $("create-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const properties = { ...linked };
    for (const field of fields) properties[field.name] = form.get(field.name);
    const nextStyle = { ...style, stroke: form.get("styleStroke") || style.stroke };
    if (form.get("styleFill")) nextStyle.fill = form.get("styleFill");
    const created = await api("/api/features", {
      method: "POST",
      body: JSON.stringify({ networkId: state.network.id, xType, name: properties.name, geometry, properties, style: nextStyle })
    });
    state.createParent = null;
    state.selectedId = created.id;
    closePanel();
    if (state.map.getZoom() < 17) state.map.setZoom(17);
    state.map.panTo(created.centroid);
    loadFeatures();
    openFeature(created.id, false, parent ? [parent] : []);
  };
}

function addChildRecord(parent, kind) {
  openPanel(`Add ${kind}`, `
    <form id="child-form">
      ${row("Name", "name", "", true)}
      ${row("Comments", "comments", "", true)}
      <div class="panel-actions"><button class="primary" type="submit">Save</button></div>
    </form>`);
  $("child-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api("/api/catalog", {
      method: "POST",
      body: JSON.stringify({
        networkId: state.network.id,
        category: kind.toLowerCase(),
        objectType: parent.typeLabel || label(parent.xType),
        name: form.get("name"),
        properties: { parentId: parent.id, parentSourceId: parent.sourceId, comments: form.get("comments") }
      })
    });
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        networkId: state.network.id,
        featureId: parent.id,
        title: `${kind}: ${form.get("name")}`,
        body: form.get("comments") || ""
      })
    });
    openFeature(parent.id, false);
  };
}

function addSplitter(feature) {
  const types = state.catalog.filter((item) => item.object_type === "PON Splitter Type");
  openPanel("Add splitter", `
    <form id="splitter-form">
      ${row("Name", "name", "", true)}
      <div class="form-row"><label>Type</label>
        <select name="type">${types.map((item) => `<option>${escapeHtml(item.name)}</option>`).join("") || "<option>1x8 Splitter</option>"}</select>
      </div>
      ${row("Comments", "comments", "", true)}
      <div class="panel-actions"><button class="primary" type="submit">Save</button></div>
    </form>`);
  $("splitter-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api("/api/catalog", {
      method: "POST",
      body: JSON.stringify({
        networkId: state.network.id,
        category: "splitter",
        objectType: "PON Splitter Type",
        name: form.get("name") || form.get("type"),
        properties: { spliceId: feature.id, enclosureid: feature.sourceId, type: form.get("type"), comments: form.get("comments") }
      })
    });
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({
        networkId: state.network.id,
        featureId: feature.id,
        title: `Splitter: ${form.get("name") || form.get("type")}`,
        body: form.get("comments") || form.get("type")
      })
    });
    openSpliceKey(feature.id);
  };
}

async function showOnMap(id) {
  await zoomToFeature(id);
  state.selectedId = id;
  refreshNetwork();
}

async function openFiles(id) {
  const feature = await api(`/api/features/${id}`);
  const files = await api(`/api/features/${id}/files`);
  openPanel(`Files — ${feature.name || feature.sourceId || ""}`, `
    ${files.map((file) => `<div class="list-card"><strong>${escapeHtml(file.name)}</strong><div class="muted">${escapeHtml(file.note || "")} · ${escapeHtml(file.created_by || "")}</div></div>`).join("") || `<p class="muted">No files related to this object.</p>`}
    <form id="file-form">
      ${row("Name", "name", "", true)}
      ${row("Note", "note", "", true)}
      <div class="panel-actions"><button class="primary" type="submit">Add file</button></div>
    </form>`);
  $("file-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api(`/api/features/${id}/files`, { method: "POST", body: JSON.stringify({ name: form.get("name"), note: form.get("note") }) });
    openFiles(id);
  };
}

async function addWorkOrder(feature) {
  const created = await api("/api/work-orders", {
    method: "POST",
    body: JSON.stringify({ featureId: feature.id, title: `${feature.typeLabel || label(feature.xType)} ${feature.name || feature.sourceId || ""}` })
  });
  openPanel("Work order", `<p>Added to work order <strong>#${created.id}</strong>.</p><p class="muted">${escapeHtml(created.title)}</p>`);
}

async function editFeatureStyle(id) {
  const feature = await api(`/api/features/${id}`);
  openPanel(`Edit Style — ${feature.name || ""}`, `
    <form id="style-form">
      ${row("Stroke", "stroke", feature.style?.stroke || "#000000", true, "color")}
      ${row("Fill", "fill", feature.style?.fill || "#E0E0E0", true, "color")}
      <div class="panel-actions"><button class="primary" type="submit">Save style</button></div>
    </form>`);
  $("style-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api(`/api/features/${id}`, {
      method: "PUT",
      body: JSON.stringify({ style: { ...(feature.style || {}), stroke: form.get("stroke"), fill: form.get("fill") }, geometry: feature.geometry, properties: feature.properties, name: feature.name })
    });
    closePanel();
    loadFeatures();
  };
}

async function openSpliceView(id, mode) {
  const data = await api(`/api/features/${id}/splice-key`);
  state.spliceKey = data;
  const splice = data.splice;
  const cables = data.cables || [];
  const pairs = data.pairs || [];
  const title = mode === "diagram"
    ? `${String(splice.name || "Splice").toUpperCase()} - SPLICE KEY DIAGRAM`
    : `${{ editor: "Splice Key Editor", list: "Splice List", sheet: "Splice Spreadsheet" }[mode] || "Splice Key"} — ${splice.name || ""}`;
  openPanel(title, spliceViewHtml(mode, data), true);
  $("float-panel").classList.toggle("sk-win", mode === "diagram");
  wireSpliceView(id, mode, splice, cables, pairs);
}

function spliceViewHtml(mode, data) {
  const splice = data.splice;
  const cables = data.cables || [];
  const pairs = data.pairs || [];
  const fields = fieldsFor(splice);
  const related = splice.related || [];
  const tabs = [["diagram", "Diagram"], ["editor", "Editor"], ["list", "List"], ["sheet", "Spreadsheet"]]
    .map(([key, caption]) => `<button type="button" class="sk-tab${mode === key ? " active" : ""}" data-sk="${key}">${caption}</button>`).join("");
  if (mode === "diagram") return spliceDiagramHtml(data);
  return `
    <div class="sk">
      <div class="identify-tabs">${tabs}</div>
      <div class="sk-body">${spliceBody(mode, splice, cables, pairs, fields, related)}</div>
    </div>`;
}

function spliceBody(mode, splice, cables, pairs, fields, related) {
  if (mode === "editor") return spliceEditorHtml(cables, pairs);
  if (mode === "list") {
    return `
      <table class="attr-table">
        <thead><tr><th>A Cable</th><th>A Fiber</th><th>B Cable</th><th>B Fiber</th><th>Kind</th></tr></thead>
        <tbody>
          ${pairs.map((pair) => `<tr>
            <td>${escapeHtml(cableName(cables, pair.aCableId))}</td><td>${pair.aFiber}</td>
            <td>${escapeHtml(cableName(cables, pair.bCableId))}</td><td>${pair.bFiber}</td>
            <td>${escapeHtml(pair.kind)}</td>
          </tr>`).join("") || `<tr><td colspan="5">No splices saved yet. Open Splice Key Editor to pair fibers.</td></tr>`}
        </tbody>
      </table>
      ${relatedBlock(related)}`;
  }
  if (mode === "sheet") return spliceSheetHtml(cables, pairs);
  return `<table class="attr-table"><tbody>${fields.map((field) => `<tr><th>${escapeHtml(field.caption)}</th><td>${escapeHtml(field.value)}</td></tr>`).join("")}</tbody></table>`;
}

function relatedBlock(related) {
  return `<h3 class="sk-h">Relations</h3>${related.length
    ? related.map((item) => `<button type="button" class="related-item" data-open="${item.id}">${objectIcon(item.xType)}<span><strong>${escapeHtml(item.typeLabel)} — ${escapeHtml(item.name || "")}</strong><small>${escapeHtml(roleLabel(item.role))}</small></span></button>`).join("")
    : `<p class="muted">No related objects.</p>`}`;
}

function cableName(cables, id) {
  return cables.find((cable) => cable.id === id)?.name || String(id || "");
}

function spliceDiagramHtml(data) {
  const header = data.header || {};
  const splitters = data.splitters || [];
  const spans = data.spans || [];
  const cards = [
    ...splitters.map((item) => ({ kind: "splitter", ...item })),
    ...spans.map((item) => ({ kind: "span", ...item, name: item.span || item.name }))
  ];
  const field = (caption, value) => `<div class="sk-row"><span class="sk-k">${caption}</span><b>${escapeHtml(blank(value))}</b></div>`;
  return `
    <div class="sk-osp">
      <div class="sk-osp-toolbar">
        <button type="button" id="sk-png">Save as PNG</button>
        <button type="button" id="sk-history">Splice History</button>
      </div>
      <div class="sk-osp-info">
        ${field("Splice Point:", header.name)}
        ${field("Location:", header.location)}
        ${field("Address Notes:", header.addressNotes)}
        ${field("Manufacturer:", header.manufacturer)}
        ${field("Part Number:", header.partNumber)}
        <div class="sk-row"><span class="sk-k">Splice Comments:</span></div>
        <div class="sk-osp-comments">${escapeHtml(header.comments || "").replace(/\n/g, "<br>")}</div>
      </div>
      <div class="sk-osp-tree">
        <div class="sk-osp-cards">
          ${cards.map((card, index) => `
            <div class="sk-card ${card.kind}" data-kind="${card.kind}" data-name="${escapeHtml(card.name)}" data-index="${index}">
              <div class="sk-card-body">
                <div><span class="sk-k">${card.kind === "splitter" ? "Splitter" : "Span"}:</span> ${escapeHtml(card.name)}</div>
                <div><span class="sk-k">Locate ID:</span> ${escapeHtml(blank(card.locateId))}</div>
                <div><span class="sk-k">Seq:</span> ${escapeHtml(blank(card.seq))}</div>
                <div><span class="sk-k">Count:</span> ${escapeHtml(card.count)}</div>
              </div>
              <div class="ports">${(card.ports || []).map((port) => `<div>${escapeHtml(port)}</div>`).join("")}</div>
            </div>`).join("") || `<p class="muted">No splitters or spans at this enclosure.</p>`}
        </div>
        <svg class="sk-osp-braces" id="sk-braces"></svg>
      </div>
      <div class="sk-osp-hint" id="sk-link-hint">Hover a line to see which splitter connects to which span</div>
    </div>`;
}

function blank(value) {
  if (value === null || value === undefined || value === "") return "none";
  return String(value);
}

function cableColumn(cable) {
  return `<div class="sk-cable" data-cable="${cable.id}">
    <div class="sk-cable-name">${escapeHtml(cable.name)} · ${cable.fiberCount}F</div>
    ${cable.fibers.map((fiber) => `<div class="sk-fiber" data-cable="${cable.id}" data-fiber="${fiber.no}"><i style="background:${fiber.hex}"></i><span>F${fiber.no}</span><em>${fiber.color}</em></div>`).join("")}
  </div>`;
}

function fiberAnchor(left, right, cableId, fiberNo, fallbackSide) {
  const findSide = (list, side) => {
    let y = 36;
    for (const cable of list) {
      y += 28;
      for (const fiber of cable.fibers) {
        if (cable.id === cableId && fiber.no === fiberNo) return { x: side === "left" ? 8 : 252, y: y + 8, hex: fiber.hex };
        y += 22;
      }
      y += 16;
    }
    return null;
  };
  return findSide(left, "left") || findSide(right, "right") || (fallbackSide === "left" ? { x: 8, y: 40, hex: "#888" } : { x: 252, y: 40, hex: "#888" });
}

function spliceEditorHtml(cables, pairs) {
  return `
    <p class="hint">Click a fiber on one cable, then a fiber on another cable to splice them. Saved pairs are listed below.</p>
    <div class="sk-editor">${cables.map((cable) => cableColumn(cable)).join("") || `<p class="muted">No cables touch this splice yet.</p>`}</div>
    <div id="sk-pending" class="muted">Select first fiber…</div>
    <table class="attr-table" id="sk-pairs">
      <thead><tr><th>A Cable</th><th>A Fiber</th><th>B Cable</th><th>B Fiber</th><th></th></tr></thead>
      <tbody>${pairRows(cables, pairs)}</tbody>
    </table>
    <div class="panel-actions"><button class="primary" type="button" id="sk-save">Save splice key</button></div>`;
}

function pairRows(cables, pairs) {
  return pairs.map((pair, index) => `<tr>
    <td>${escapeHtml(cableName(cables, pair.aCableId))}</td><td>${pair.aFiber}</td>
    <td>${escapeHtml(cableName(cables, pair.bCableId))}</td><td>${pair.bFiber}</td>
    <td><button type="button" data-unpair="${index}">Remove</button></td>
  </tr>`).join("") || `<tr><td colspan="5">No pairs yet</td></tr>`;
}

function spliceSheetHtml(cables, pairs) {
  const rows = [];
  for (const cable of cables) {
    for (const fiber of cable.fibers) {
      const pair = pairs.find((item) => (item.aCableId === cable.id && item.aFiber === fiber.no) || (item.bCableId === cable.id && item.bFiber === fiber.no));
      const other = pair ? (pair.aCableId === cable.id ? { id: pair.bCableId, fiber: pair.bFiber } : { id: pair.aCableId, fiber: pair.aFiber }) : null;
      rows.push(`<tr>
        <td>${escapeHtml(cable.name)}</td>
        <td>F${fiber.no}</td>
        <td><i class="swatch" style="background:${fiber.hex}"></i> ${fiber.color}</td>
        <td>Tube ${fiber.tube}</td>
        <td>${other ? escapeHtml(cableName(cables, other.id)) : ""}</td>
        <td>${other ? `F${other.fiber}` : "unspliced"}</td>
      </tr>`);
    }
  }
  return `<table class="attr-table">
    <thead><tr><th>Cable</th><th>Fiber</th><th>Color</th><th>Buffer</th><th>Spliced to cable</th><th>Spliced to fiber</th></tr></thead>
    <tbody>${rows.join("") || `<tr><td colspan="6">No cable fibers at this splice.</td></tr>`}</tbody>
  </table>`;
}

function wireSpliceView(id, mode, splice, cables, pairs) {
  $("panel-body").querySelectorAll("[data-sk]").forEach((button) => {
    button.onclick = () => openSpliceView(id, button.dataset.sk);
  });
  $("panel-body").querySelectorAll("[data-open]").forEach((button) => {
    button.onclick = () => openFeature(Number(button.dataset.open), false, [splice]);
  });
  if (mode === "diagram") {
    requestAnimationFrame(() => {
      drawSpliceBraces();
      wireSpliceLinks();
    });
    const png = $("sk-png");
    if (png) png.onclick = () => saveDiagramPng(splice.name || "splice-key");
    const history = $("sk-history");
    if (history) {
      history.onclick = () => {
        const comments = state.spliceKey?.header?.comments || "No splice history stored for this enclosure.";
        openPanel("Splice History", `<div class="sk-osp-info"><pre class="sk-history">${escapeHtml(comments || "No splice history stored for this enclosure.")}</pre></div>
          <p class="muted" style="padding:8px 12px">${pairs.length} saved fiber pairs.</p>
          <div class="panel-actions" style="padding:0 12px 12px"><button type="button" id="sk-back">Back to diagram</button></div>`);
        $("sk-back").onclick = () => openSpliceView(id, "diagram");
      };
    }
    return;
  }
  if (mode !== "editor") return;
  let pending = null;
  const draft = pairs.map((pair) => ({ ...pair }));
  const redraw = () => {
    const body = $("sk-pairs")?.querySelector("tbody");
    if (body) body.innerHTML = pairRows(cables, draft);
    $("panel-body").querySelectorAll("[data-unpair]").forEach((button) => {
      button.onclick = () => { draft.splice(Number(button.dataset.unpair), 1); redraw(); };
    });
  };
  $("panel-body").querySelectorAll(".sk-fiber").forEach((el) => {
    el.onclick = () => {
      const pick = { cableId: Number(el.dataset.cable), fiber: Number(el.dataset.fiber) };
      if (!pending) {
        pending = pick;
        $("sk-pending").textContent = `Selected ${cableName(cables, pick.cableId)} F${pick.fiber}. Now click the other fiber.`;
        return;
      }
      if (pending.cableId === pick.cableId && pending.fiber === pick.fiber) return;
      draft.push({ aCableId: pending.cableId, aFiber: pending.fiber, bCableId: pick.cableId, bFiber: pick.fiber, kind: "splice" });
      pending = null;
      $("sk-pending").textContent = "Pair added. Select first fiber…";
      redraw();
    };
  });
  redraw();
  $("sk-save").onclick = async () => {
    await api(`/api/features/${id}/splice-key`, { method: "PUT", body: JSON.stringify({ pairs: draft }) });
    openSpliceView(id, "diagram");
  };
}

function drawSpliceBraces() {
  const svg = $("sk-braces");
  const tree = document.querySelector(".sk-osp-tree");
  const splitters = [...document.querySelectorAll(".sk-card.splitter")];
  const spans = [...document.querySelectorAll(".sk-card.span")];
  const cards = [...document.querySelectorAll(".sk-card")];
  if (!svg || !tree || !cards.length) return;
  const treeBox = tree.getBoundingClientRect();
  const width = Math.max(treeBox.width, 360);
  const height = Math.max(treeBox.height, 80);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  const edge = (el) => {
    const box = el.getBoundingClientRect();
    return {
      el,
      name: el.dataset.name || "",
      x: box.right - treeBox.left,
      y: box.top - treeBox.top + box.height / 2
    };
  };
  const links = [];
  if (splitters.length && spans.length) {
    const count = Math.max(splitters.length, spans.length);
    for (let i = 0; i < count; i += 1) {
      const splitter = edge(splitters[i % splitters.length]);
      const span = edge(spans[i % spans.length]);
      if (links.some((link) => link.splitter.el === splitter.el && link.span.el === span.el)) continue;
      links.push({ splitter, span });
    }
  } else {
    const nodes = cards.map(edge);
    for (let i = 1; i < nodes.length; i += 1) links.push({ splitter: nodes[0], span: nodes[i] });
  }
  const routeBase = Math.max(...cards.map((card) => edge(card).x)) + 18;
  const color = "#7eb6d9";
  svg.innerHTML = links.map((link, index) => {
    const x = routeBase + index * 16;
    const d = `M${link.splitter.x},${link.splitter.y} H${x} V${link.span.y} H${link.span.x}`;
    const label = `Splitter ${link.splitter.name} → Span ${link.span.name}`;
    return `<g class="sk-conn" data-from="${escapeHtml(link.splitter.name)}" data-to="${escapeHtml(link.span.name)}" data-label="${escapeHtml(label)}">
      <path class="sk-link-hit" d="${d}" fill="none"/>
      <path class="sk-link" d="${d}" fill="none" stroke="${color}" stroke-width="2"/>
    </g>`;
  }).join("");
}

function wireSpliceLinks() {
  const hint = $("sk-link-hint");
  const idle = "Hover a line to see which splitter connects to which span";
  const setHot = (from, to, on) => {
    document.querySelectorAll(".sk-card").forEach((card) => {
      const match = (card.dataset.kind === "splitter" && card.dataset.name === from)
        || (card.dataset.kind === "span" && card.dataset.name === to);
      card.classList.toggle("hot", Boolean(on && match));
    });
    document.querySelectorAll(".sk-conn").forEach((conn) => {
      conn.classList.toggle("hot", Boolean(on && conn.dataset.from === from && conn.dataset.to === to));
    });
  };
  document.querySelectorAll(".sk-conn").forEach((conn) => {
    const enter = () => {
      setHot(conn.dataset.from, conn.dataset.to, true);
      if (hint) hint.textContent = conn.dataset.label;
    };
    const leave = () => {
      setHot(conn.dataset.from, conn.dataset.to, false);
      if (hint) hint.textContent = idle;
    };
    conn.addEventListener("mouseenter", enter);
    conn.addEventListener("mouseleave", leave);
  });
  document.querySelectorAll(".sk-card").forEach((card) => {
    card.addEventListener("mouseenter", () => {
      const conn = [...document.querySelectorAll(".sk-conn")].find((item) => (
        card.dataset.kind === "splitter" ? item.dataset.from === card.dataset.name : item.dataset.to === card.dataset.name
      ));
      if (!conn) return;
      setHot(conn.dataset.from, conn.dataset.to, true);
      if (hint) hint.textContent = conn.dataset.label;
    });
    card.addEventListener("mouseleave", () => {
      setHot("", "", false);
      if (hint) hint.textContent = idle;
    });
  });
}

function saveDiagramPng(name) {
  const data = state.spliceKey || {};
  const header = data.header || {};
  const cards = [
    ...(data.splitters || []).map((item) => ({ kind: "splitter", ...item })),
    ...(data.spans || []).map((item) => ({ kind: "span", name: item.span, ...item }))
  ];
  const width = 520;
  const cardH = 78;
  const gap = 12;
  const infoH = 148;
  const height = 56 + infoH + 24 + cards.length * (cardH + gap) + 36;
  const canvas = document.createElement("canvas");
  canvas.width = width * 2;
  canvas.height = height * 2;
  const ctx = canvas.getContext("2d");
  ctx.scale(2, 2);
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#f3f3f3";
  ctx.fillRect(0, 0, width, 28);
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 13px Segoe UI, sans-serif";
  ctx.fillText(`${String(header.name || name || "SPLICE").toUpperCase()} - SPLICE KEY DIAGRAM`, 12, 18);
  ctx.fillStyle = "#ececec";
  ctx.fillRect(0, 28, width, 26);
  ctx.fillStyle = "#333";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.fillText("Save as PNG     Splice History", 12, 45);
  ctx.fillStyle = "#f6eec0";
  ctx.fillRect(0, 54, width, infoH);
  ctx.fillStyle = "#222";
  const lines = [
    ["Splice Point:", blank(header.name)],
    ["Location:", blank(header.location)],
    ["Address Notes:", blank(header.addressNotes)],
    ["Manufacturer:", blank(header.manufacturer)],
    ["Part Number:", blank(header.partNumber)],
    ["Splice Comments:", header.comments || ""]
  ];
  lines.forEach((line, index) => {
    const y = 76 + index * 20;
    ctx.font = "13px Segoe UI, sans-serif";
    ctx.fillText(line[0], 18, y);
    ctx.font = "bold 13px Segoe UI, sans-serif";
    ctx.fillText(String(line[1] || ""), 18 + ctx.measureText(line[0] + " ").width + 70, y);
  });
  cards.forEach((card, index) => {
    const x = 22;
    const y = 54 + infoH + 18 + index * (cardH + gap);
    roundRect(ctx, x, y, 280, cardH, 6);
    ctx.fillStyle = card.kind === "splitter" ? "#f4a024" : "#cfcfcf";
    ctx.fill();
    ctx.strokeStyle = "#6e6e6e";
    ctx.stroke();
    ctx.fillStyle = "#222";
    ctx.font = "13px Segoe UI, sans-serif";
    const label = card.kind === "splitter" ? "Splitter" : "Span";
    [
      `${label}: ${card.name}`,
      `Locate ID: ${blank(card.locateId)}`,
      `Seq: ${blank(card.seq)}`,
      `Count: ${card.count}`
    ].forEach((text, row) => ctx.fillText(text, x + 10, y + 18 + row * 16));
    (card.ports || []).forEach((port, row) => ctx.fillText(port, x + 232, y + 18 + row * 16));
  });
  const link = document.createElement("a");
  link.download = `${String(name || "splice-key").replace(/\s+/g, "-")}-diagram.png`;
  link.href = canvas.toDataURL("image/png");
  link.click();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function noteFor(feature) {
  openPanel("Field note", `
    <form id="note-form">
      ${row("Title", "title", feature.name || "Field note", true)}
      <div class="form-row"><label>Note</label><textarea name="body" required></textarea></div>
      <div class="panel-actions"><button class="primary" type="submit">Save</button></div>
    </form>`);
  $("note-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api("/api/notes", {
      method: "POST",
      body: JSON.stringify({ networkId: state.network.id, featureId: feature.id, title: form.get("title"), body: form.get("body") })
    });
    closePanel();
  };
}

function openPanel(title, html, wide = false) {
  $("panel-title").textContent = title;
  $("panel-body").innerHTML = html;
  $("float-panel").classList.toggle("wide", Boolean(wide));
  if (!String(html).includes("sk-osp")) $("float-panel").classList.remove("sk-win");
  $("float-panel").hidden = false;
}
function closePanel() {
  $("float-panel").hidden = true;
  $("float-panel").classList.remove("wide");
  $("float-panel").classList.remove("sk-win");
}

function rememberView() {
  if (!state.map || state.movingHistory) return;
  const center = state.map.getCenter();
  const view = { lat: center.lat(), lng: center.lng(), zoom: state.map.getZoom() };
  const last = state.history[state.history.length - 1];
  if (last && Math.abs(last.lat - view.lat) < 0.00001 && Math.abs(last.lng - view.lng) < 0.00001 && last.zoom === view.zoom) return;
  state.history.push(view);
  if (state.history.length > 40) state.history.shift();
  state.future = [];
  $("next-view").disabled = true;
}

function goView(view) {
  state.movingHistory = true;
  state.map.setCenter(view);
  state.map.setZoom(view.zoom);
  setTimeout(() => { state.movingHistory = false; }, 400);
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", async () => {
    const panel = button.dataset.panel;
    const sub = document.querySelector(`.sub[data-for="${panel}"]`);
    if (sub) {
      sub.classList.toggle("open");
      button.classList.toggle("open");
      return;
    }
    if (panel === "alarms") showAlarms();
    if (panel === "notes") showNotes();
    if (panel === "log") showLog();
    if (panel === "settings") showSettings();
  });
});

document.querySelector(".sub[data-for='maptools']").addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (action === "refresh") loadFeatures();
  if (action === "clear-highlight") { state.selectedId = null; loadFeatures(); }
  if (action === "clear-map") { state.visible = Object.fromEntries(Object.keys(state.visible).map((key) => [key, false])); renderLegend(); loadFeatures(); }
  if (action === "layers") showLayers();
  if (action === "bookmark") showBookmarks();
  if (action === "geocode") showGeocode();
});

$("type-list").addEventListener("click", (event) => {
  const type = event.target.closest("button")?.dataset.openTypes;
  if (type) showCatalog("default_type", type);
});
$("attribute-list").addEventListener("click", (event) => {
  const type = event.target.closest("button")?.dataset.attributes;
  if (type) showAttributes(type);
});
$("theme-list").addEventListener("click", (event) => {
  const xType = event.target.closest("button")?.dataset.theme;
  if (xType) showTheme(xType);
});
$("network-list").addEventListener("click", (event) => {
  const id = Number(event.target.closest("button")?.dataset.network);
  const network = state.networks.find((item) => item.id === id);
  if (!network) return;
  state.network = network;
  $("network-badge").textContent = network.name;
  drawBoundary();
  const bounds = boundsOf(network.boundary);
  if (bounds) state.map.fitBounds(bounds);
  loadFeatures();
});

function showCatalog(category, objectType) {
  const items = state.catalog.filter((item) => item.category === category && item.object_type === objectType);
  openPanel(objectType, `
    <div id="catalog-items">${items.map((item) => `<div class="list-card"><strong>${escapeHtml(item.name)}</strong></div>`).join("") || `<p class="muted">None saved yet.</p>`}</div>
    <form id="catalog-form">
      ${row("Name", "name", "", true)}
      <div class="panel-actions"><button class="primary" type="submit">Add</button></div>
    </form>`);
  $("catalog-form").onsubmit = async (event) => {
    event.preventDefault();
    const name = new FormData(event.target).get("name");
    const created = await api("/api/catalog", { method: "POST", body: JSON.stringify({ networkId: state.network.id, category, objectType, name }) });
    state.catalog.push(created);
    renderSidebar();
    showCatalog(category, objectType);
  };
}

function showTheme(xType) {
  const style = state.styles[xType] || {};
  const current = (state.settings.themes && state.settings.themes[xType]) || {};
  openPanel(`${label(xType)} theme`, `
    <form id="theme-form">
      <label class="check"><input type="checkbox" name="enabled" ${current.enabled ? "checked" : ""}> Use this theme on the map</label>
      ${row("Stroke", "stroke", current.stroke || style.stroke || "#000000", true, "color")}
      ${style.fill || current.fill ? row("Fill", "fill", current.fill || style.fill || "#E0E0E0", true, "color") : ""}
      <div class="panel-actions"><button class="primary" type="submit">Apply</button></div>
    </form>`);
  $("theme-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.settings.themes = state.settings.themes || {};
    state.settings.themes[xType] = {
      enabled: form.get("enabled") === "on",
      stroke: form.get("stroke"),
      fill: form.get("fill") || undefined
    };
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ themes: state.settings.themes }) });
    loadFeatures();
    closePanel();
  };
}

function layerColor(xType) {
  if (xType === "sp") return "#FFFF00";
  const style = state.styles[xType] || {};
  return style.fill || style.stroke || "#6fbe44";
}

function layerCount(xType) {
  return (state.counts || []).filter((row) => row.x_type === xType).reduce((sum, row) => sum + Number(row.count || 0), 0);
}

function renderLegend() {
  const box = $("layer-legend");
  if (!box) return;
  const keys = Object.keys(state.visible);
  box.innerHTML = keys.map((key) => `
    <label class="${state.visible[key] ? "" : "off"}" title="${escapeHtml(label(key))}">
      <input type="checkbox" data-layer="${key}" ${state.visible[key] ? "checked" : ""}>
      <i class="swatch" style="background:${escapeHtml(layerColor(key))}"></i>
      <span>${escapeHtml(label(key))}</span>
      <em>${layerCount(key) || ""}</em>
    </label>`).join("");
  box.querySelectorAll("input").forEach((input) => {
    input.onchange = () => {
      state.visible[input.dataset.layer] = input.checked;
      renderLegend();
      loadFeatures();
    };
  });
}

function showAttributes(typeName) {
  const xType = {
    Building: "bdg", Cable: "cab", "Access Point": "ap", "Splice Point": "sp",
    "Term Point": "tp", Pole: "pole", Slack: "sla", "Duct Bank": "db", "Aerial Strand": "pln"
  }[typeName];
  const fields = state.fieldDefs
    .filter((field) => field.x_type === xType)
    .sort((a, b) => (a.fieldorder || 0) - (b.fieldorder || 0) || String(a.caption).localeCompare(String(b.caption)));
  openPanel(`${typeName} attributes`, `
    <p class="hint">${fields.length} Medianet Atlas fields for this layer. Right-click an object on the map to Identify every value.</p>
    <table class="attr-table">
      <tbody>
        ${fields.map((field) => `<tr><th>${escapeHtml(prettyCaption(field.fieldname, field.caption))}</th><td>${escapeHtml(field.fieldname)}${field.required ? " · required" : ""}${field.visible ? "" : " · hidden"}</td></tr>`).join("") || `<tr><td>No dictionary fields stored for this layer.</td></tr>`}
      </tbody>
    </table>`);
}

function showLayers() {
  const keys = Object.keys(state.visible);
  openPanel("Layer Control", `
    <form id="layer-form" class="layer-form">
      ${keys.map((key) => `<label class="check layer-row">
        <input type="checkbox" name="${key}" ${state.visible[key] ? "checked" : ""}>
        <i class="swatch" style="background:${escapeHtml(layerColor(key))}"></i>
        <span>${escapeHtml(label(key))}</span>
        <em class="muted">${layerCount(key)}</em>
      </label>`).join("")}
      <div class="panel-actions"><button class="primary" type="submit">Update Map</button></div>
    </form>`);
  $("layer-form").onsubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    for (const key of keys) state.visible[key] = form.get(key) === "on";
    renderLegend();
    closePanel();
    loadFeatures();
  };
}

async function showBookmarks() {
  const bookmarks = await api(`/api/bookmarks?networkId=${state.network.id}`);
  openPanel("Bookmarks", `
    ${bookmarks.map((item) => `<div class="list-card"><button type="button" data-go="${item.id}">${escapeHtml(item.name)}</button> <span class="muted">zoom ${item.zoom}</span></div>`).join("") || `<p class="muted">No bookmarks yet.</p>`}
    <form id="bookmark-form">${row("Name", "name", "", true)}<div class="panel-actions"><button class="primary" type="submit">Save current view</button></div></form>`);
  $("panel-body").querySelectorAll("[data-go]").forEach((button) => {
    button.onclick = () => {
      const item = bookmarks.find((bookmark) => bookmark.id === Number(button.dataset.go));
      state.map.setCenter({ lat: item.lat, lng: item.lng });
      state.map.setZoom(item.zoom);
    };
  });
  $("bookmark-form").onsubmit = async (event) => {
    event.preventDefault();
    const center = state.map.getCenter();
    await api("/api/bookmarks", {
      method: "POST",
      body: JSON.stringify({ networkId: state.network.id, name: new FormData(event.target).get("name"), lat: center.lat(), lng: center.lng(), zoom: state.map.getZoom() })
    });
    showBookmarks();
  };
}

function showGeocode() {
  openPanel("Geocode Address", `<form id="geo-form">${row("Address", "address", "", true)}<div class="panel-actions"><button class="primary" type="submit">Find</button></div><p id="geo-error" class="error"></p></form>`);
  $("geo-form").onsubmit = (event) => {
    event.preventDefault();
    const address = new FormData(event.target).get("address");
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ address }, (results, status) => {
      if (status !== "OK" || !results[0]) { $("geo-error").textContent = "Address was not found"; return; }
      state.map.fitBounds(results[0].geometry.viewport || results[0].geometry.bounds);
      closePanel();
    });
  };
}

function geocodePoint(latLng) {
  if (!latLng) return;
  const geocoder = new google.maps.Geocoder();
  geocoder.geocode({ location: latLng }, (results, status) => {
    openPanel("Location", `<p>${status === "OK" && results[0] ? escapeHtml(results[0].formatted_address) : "No address found"}</p><p class="muted">${latLng.lat().toFixed(6)}, ${latLng.lng().toFixed(6)}</p>`);
  });
}

async function showAlarms() {
  const alarms = await api(`/api/alarms?networkId=${state.network.id}`);
  openPanel("Alarm Viewer", `
    ${alarms.map((alarm) => `<div class="list-card"><strong>${escapeHtml(alarm.severity)}</strong>${escapeHtml(alarm.message)}<div class="muted">${escapeHtml(alarm.feature_name || "")} · ${escapeHtml(alarm.status)}</div></div>`).join("") || `<p class="muted">No alarms.</p>`}
    <form id="alarm-form">
      ${row("Message", "message", "", true)}
      <div class="form-row"><label>Severity</label><select name="severity"><option>warning</option><option>critical</option><option>info</option></select></div>
      <div class="panel-actions"><button class="primary" type="submit">Add alarm</button></div>
    </form>`);
  $("alarm-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    await api("/api/alarms", { method: "POST", body: JSON.stringify({ networkId: state.network.id, message: form.get("message"), severity: form.get("severity") }) });
    showAlarms();
  };
}

async function showNotes() {
  const notes = await api(`/api/notes?networkId=${state.network.id}`);
  openPanel("Field Notes", notes.map((note) => `<div class="list-card"><strong>${escapeHtml(note.title)}</strong><div>${escapeHtml(note.body)}</div><div class="muted">${escapeHtml(note.feature_name || note.created_by || "")} · ${escapeHtml(note.status)}</div></div>`).join("") || `<p class="muted">No field notes.</p>`);
}

async function showLog() {
  const rows = await api("/api/log");
  openPanel("Log", rows.map((row) => `<div class="list-card"><strong>${escapeHtml(row.action)}</strong><div class="muted">${escapeHtml(row.username || "")} · ${new Date(row.created_at).toLocaleString()}</div><div>${escapeHtml(JSON.stringify(row.detail))}</div></div>`).join("") || `<p class="muted">No log entries.</p>`);
}

function showSettings() {
  openPanel("Settings", `
    <form id="settings-form">
      <label class="check"><input type="checkbox" name="showLabels" ${state.settings.showLabels ? "checked" : ""}> Show names from zoom 17</label>
      <div class="form-row"><label>Base map</label>
        <select name="mapType">
          ${["roadmap", "terrain", "satellite", "hybrid"].map((type) => `<option ${state.map.getMapTypeId() === type ? "selected" : ""}>${type}</option>`).join("")}
        </select>
      </div>
      <div class="panel-actions"><button class="primary" type="submit">Save</button></div>
    </form>`);
  $("settings-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    state.settings.showLabels = form.get("showLabels") === "on";
    state.settings.mapType = form.get("mapType");
    state.map.setMapTypeId(state.settings.mapType);
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ showLabels: state.settings.showLabels, mapType: state.settings.mapType }) });
    loadFeatures();
    closePanel();
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

$("logout").onclick = () => { sessionStorage.removeItem("osp_token"); location.reload(); };
$("panel-close").onclick = closePanel;
$("search-clear").onclick = () => { $("search").value = ""; $("search-results").innerHTML = ""; };
let searchTimer;
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("search").value.trim();
    if (!q) { $("search-results").innerHTML = ""; return; }
    const rows = await api(`/api/search?networkId=${state.network.id}&q=${encodeURIComponent(q)}`);
    $("search-results").innerHTML = rows.map((row) => `<button type="button" data-id="${row.id}"><strong>${escapeHtml(row.name || "(unnamed)")}</strong><br><small>${escapeHtml(row.typeLabel)} ${row.sourceId || ""}</small></button>`).join("") || `<button type="button" disabled>No matches</button>`;
    $("search-results").querySelectorAll("[data-id]").forEach((button) => {
      button.onclick = async () => {
        $("search-results").innerHTML = "";
        await zoomToFeature(Number(button.dataset.id));
        openFeature(Number(button.dataset.id), false);
      };
    });
  }, 250);
});

$("zoom-in").onclick = () => state.map.setZoom(state.map.getZoom() + 1);
$("zoom-out").onclick = () => state.map.setZoom(state.map.getZoom() - 1);
$("base-map-btn").onclick = () => { $("base-map-menu").hidden = !$("base-map-menu").hidden; };
$("base-map-menu").querySelectorAll("button").forEach((button) => {
  button.onclick = () => { state.map.setMapTypeId(button.dataset.map); $("base-map-menu").hidden = true; };
});
$("back-view").onclick = () => {
  if (state.history.length < 2) return;
  state.future.push(state.history.pop());
  goView(state.history[state.history.length - 1]);
  $("next-view").disabled = false;
};
$("next-view").onclick = () => {
  const view = state.future.pop();
  if (!view) return;
  state.history.push(view);
  goView(view);
  $("next-view").disabled = state.future.length === 0;
};
document.addEventListener("click", (event) => {
  if (!event.target.closest("#context-menu")) hideMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { hideMenu(); setDrawMode("select"); }
  if (event.key === "Enter" && state.drawMode !== "select") finishDraft();
});

if (state.token) {
  boot().catch((error) => showLogin(error.message));
}
