const DRAW_KIND = {
  bdg: "polygon", cab: "line", db: "line", pln: "line", planl: "line",
  ap: "square", sp: "square", tp: "square", pole: "point", sla: "point", planp: "point"
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
  bookmarks: [],
  map: null,
  boundary: null,
  layer: null,
  layerFeatures: [],
  editOverlay: null,
  editingId: null,
  selectedId: null,
  drawMode: "select",
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
    ? [...grouped.entries()].map(([type, names]) => `<button type="button" data-open-types="${escapeHtml(type)}">${escapeHtml(type)} <span class="muted">${escapeHtml(names[0])}</span></button>`).join("")
    : `<button type="button" data-open-types="Building Type">Building Type</button>`;
  const attributeTypes = ["Building", "Cable", "Access Point", "Splice Point", "Term Point", "Pole", "Slack", "Duct Bank", "Aerial Strand"];
  $("attribute-list").innerHTML = attributeTypes.map((name) => `<button type="button" data-attributes="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("");
  $("theme-list").innerHTML = Object.keys(state.styles).map((key) => `<button type="button" data-theme="${key}">${label(key)}</button>`).join("");
  $("network-list").innerHTML = state.networks.map((network) => `<button type="button" data-network="${network.id}">${escapeHtml(network.name)} <span class="muted">${escapeHtml(network.designation || "")}</span></button>`).join("");
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
  state.layer = createLayer(state.map);
  let loadTimer = 0;
  state.map.addListener("idle", () => {
    clearTimeout(loadTimer);
    loadTimer = setTimeout(loadFeatures, 160);
  });
  state.map.addListener("zoom_changed", () => { $("zoom-level").textContent = Math.round(state.map.getZoom()); });
  state.map.addListener("mousemove", (event) => {
    $("coords").textContent = `${event.latLng.lat().toFixed(6)}, ${event.latLng.lng().toFixed(6)}`;
  });
  state.map.addListener("click", (event) => {
    hideMenu();
    if (state.drawMode !== "select") {
      addDraftPoint(event.latLng);
      return;
    }
    const feature = hitFeature(event.latLng);
    state.selectedId = feature ? feature.id : state.selectedId;
    if (feature && state.layer) state.layer.draw();
  });
  state.map.addListener("dblclick", (event) => {
    if (state.drawMode === "select") return;
    event.stop();
    finishDraft();
  });
  state.map.addListener("rightclick", (event) => {
    const feature = state.drawMode === "select" ? hitFeature(event.latLng) : null;
    if (feature) state.selectedId = feature.id;
    if (state.layer) state.layer.draw();
    openMenu(event.domEvent, feature, event.latLng);
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
    fillColor: "#37c15b",
    fillOpacity: 0.18,
    clickable: false,
    zIndex: 1
  });
}

const DRAW_RANK = { bdg: 0, ap: 1, pole: 1, sla: 1, planp: 1, sp: 2, tp: 3, cab: 8, planl: 8, db: 8, pln: 8 };
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
    state.layerFeatures = (data.features || []).slice().sort((a, b) => (DRAW_RANK[a.xType] ?? 4) - (DRAW_RANK[b.xType] ?? 4));
    state.layerStamp = (state.layerStamp || 0) + 1;
    if (state.layer) state.layer.draw();
    $("scale-label").textContent = zoom < 15
      ? `${data.total} features. Zoom to 15 or closer to draw buildings and cables.`
      : `${state.layerFeatures.length} shown`;
  } catch (error) {
    if (error.message === "Please sign in") return;
    $("scale-label").textContent = "Could not load the map layer";
  }
}

function createLayer(map) {
  const layer = new google.maps.OverlayView();
  const canvas = document.createElement("canvas");
  canvas.style.position = "absolute";
  canvas.style.pointerEvents = "none";
  layer.canvas = canvas;
  layer.onAdd = function () {
    this.getPanes().overlayLayer.appendChild(canvas);
  };
  layer.onRemove = function () {
    canvas.remove();
  };
  layer.draw = function () {
    paintNetwork(this);
  };
  layer.setMap(map);
  return layer;
}

function worldPoint(lat, lng, scale) {
  const clamped = Math.max(-85, Math.min(85, lat));
  const sin = Math.sin(clamped * Math.PI / 180);
  return {
    x: (lng + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

function paintNetwork(layer) {
  const projection = layer.getProjection();
  const map = state.map;
  if (!projection || !map) return;
  const bounds = map.getBounds();
  if (!bounds) return;
  const sw = projection.fromLatLngToDivPixel(bounds.getSouthWest());
  const ne = projection.fromLatLngToDivPixel(bounds.getNorthEast());
  const viewLeft = Math.min(sw.x, ne.x);
  const viewTop = Math.min(sw.y, ne.y);
  const viewW = Math.abs(ne.x - sw.x);
  const viewH = Math.abs(sw.y - ne.y);
  if (viewW < 2 || viewH < 2) return;
  const canvas = layer.canvas;
  const zoom = map.getZoom();
  const stamp = `${state.layerStamp || 0}:${state.selectedId || 0}:${state.editingId || 0}`;
  const cache = layer.cache;
  if (cache && cache.zoom === zoom && cache.stamp === stamp) {
    const anchor = projection.fromLatLngToDivPixel(cache.anchor);
    if (anchor.x <= viewLeft && anchor.y <= viewTop && anchor.x + cache.width >= viewLeft + viewW && anchor.y + cache.height >= viewTop + viewH) {
      canvas.style.left = `${anchor.x}px`;
      canvas.style.top = `${anchor.y}px`;
      return;
    }
  }
  const pad = 180;
  const left = viewLeft - pad;
  const top = viewTop - pad;
  const width = viewW + pad * 2;
  const height = viewH + pad * 2;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.left = `${left}px`;
  canvas.style.top = `${top}px`;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const pixelW = Math.max(1, Math.floor(width * dpr));
  const pixelH = Math.max(1, Math.floor(height * dpr));
  if (canvas.width !== pixelW) canvas.width = pixelW;
  if (canvas.height !== pixelH) canvas.height = pixelH;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const originLL = projection.fromDivPixelToLatLng(new google.maps.Point(left, top));
  const scale = 256 * Math.pow(2, zoom);
  const origin = worldPoint(originLL.lat(), originLL.lng(), scale);
  for (const feature of state.layerFeatures) {
    if (feature.id === state.editingId) continue;
    const type = feature.geometry && feature.geometry.type;
    if (type === "Polygon" || type === "MultiPolygon") paintPolygon(ctx, feature, origin, scale);
    else if (type === "LineString" || type === "MultiLineString") paintLine(ctx, feature, origin, scale);
  }
  if (state.settings && state.settings.showLabels && zoom >= 18) paintLabels(ctx, projection, left, top);
  layer.cache = { zoom, stamp, anchor: originLL, width, height };
}

function paintPolygon(ctx, feature, origin, scale) {
  const geometry = feature.geometry;
  const rings = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const style = themedStyle(feature);
  const selected = feature.id === state.selectedId;
  ctx.beginPath();
  for (const polygon of rings) {
    for (const ring of polygon) addRing(ctx, ring, origin, scale);
  }
  ctx.fillStyle = hexToRgba(style.fill || "#E0E0E0", selected ? 0.96 : 0.9);
  ctx.fill("evenodd");
  ctx.lineWidth = (style.weight || 2) + (selected ? 2 : 0);
  ctx.strokeStyle = style.stroke || "#800080";
  ctx.setLineDash(style.dash ? [6, 5] : []);
  ctx.stroke();
}

function paintLine(ctx, feature, origin, scale) {
  const geometry = feature.geometry;
  const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  const style = themedStyle(feature);
  const selected = feature.id === state.selectedId;
  ctx.beginPath();
  for (const line of lines) addRing(ctx, line, origin, scale);
  ctx.lineWidth = (style.weight || 2) + (selected ? 2 : 0);
  ctx.strokeStyle = style.stroke || "#0B5394";
  ctx.setLineDash(style.dash ? [6, 5] : []);
  ctx.stroke();
}

function addRing(ctx, ring, origin, scale) {
  if (!ring || ring.length < 2) return;
  for (let i = 0; i < ring.length; i += 1) {
    const point = worldPoint(ring[i][1], ring[i][0], scale);
    const x = point.x - origin.x;
    const y = point.y - origin.y;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function paintLabels(ctx, projection, left, top) {
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.setLineDash([]);
  let count = 0;
  for (const feature of state.layerFeatures) {
    if (!feature.name || !feature.centroid || count >= 40) continue;
    const pixel = projection.fromLatLngToDivPixel(new google.maps.LatLng(feature.centroid.lat, feature.centroid.lng));
    const x = pixel.x - left;
    const y = pixel.y - top;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.strokeText(feature.name, x, y);
    ctx.fillStyle = "#202020";
    ctx.fillText(feature.name, x, y);
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
  const lat = latLng.lat();
  const lng = latLng.lng();
  const zoom = state.map.getZoom();
  const threshold = (156543.03392 * Math.cos(lat * Math.PI / 180)) / Math.pow(2, zoom) * 7;
  let lineHit = null;
  let lineDistance = threshold;
  for (let index = state.layerFeatures.length - 1; index >= 0; index -= 1) {
    const feature = state.layerFeatures[index];
    const geometry = feature.geometry;
    if (!geometry) continue;
    if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
      if (geometryContains(lng, lat, geometry)) return feature;
    } else if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
      const distance = lineDistanceMeters(lng, lat, geometry);
      if (distance < lineDistance) {
        lineDistance = distance;
        lineHit = feature;
      }
    }
  }
  return lineHit;
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
  if (theme && theme.enabled) return { ...feature.style, ...theme };
  return feature.style || state.styles[feature.xType] || { stroke: "#2020FF", fill: "#2020FF", weight: 2 };
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
  if (state.layer) state.layer.draw();
}

function hideMenu() { $("context-menu").hidden = true; }

function openMenu(event, feature, latLng) {
  const host = document.querySelector("main").getBoundingClientRect();
  const menu = $("context-menu");
  const x = event?.clientX ? event.clientX - host.left : 80;
  const y = event?.clientY ? event.clientY - host.top : 80;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const items = feature
    ? [
        ["Details", () => openFeature(feature.id, false)],
        ["Edit", () => openFeature(feature.id, true)],
        ["Edit shape", () => editShape(feature.id)],
        ["Zoom to", () => zoomToFeature(feature.id)],
        ["Add field note", () => noteFor(feature)],
        ["Delete", () => removeFeature(feature.id)]
      ]
    : [
        ["New Building", () => startDraw("bdg", latLng)],
        ["New Cable", () => startDraw("cab", latLng)],
        ["New Access Point", () => startDraw("ap", latLng)],
        ["New Splice Point", () => startDraw("sp", latLng)],
        ["New Term Point", () => startDraw("tp", latLng)],
        ["New Pole", () => startDraw("pole", latLng)],
        ["New Slack", () => startDraw("sla", latLng)],
        ["Geocode this point", () => geocodePoint(latLng)]
      ];
  menu.innerHTML = items.map(([text], index) => `<button type="button" data-menu="${index}">${text}</button>`).join("");
  menu.hidden = false;
  menu.querySelectorAll("button").forEach((button) => {
    button.onclick = () => { hideMenu(); items[Number(button.dataset.menu)][1](); };
  });
}

async function openFeature(id, editing) {
  const feature = await api(`/api/features/${id}`);
  state.selectedId = id;
  const fields = fieldsFor(feature);
  openPanel(`${feature.typeLabel} — ${feature.name || feature.sourceId || ""}`, `
    <form id="feature-form">
      ${fields.map((field) => row(field.caption, field.name, field.value, editing)).join("")}
      ${row("Stroke", "styleStroke", (feature.style && feature.style.stroke) || "#0B5394", editing, "color")}
      ${feature.style && feature.style.fill ? row("Fill", "styleFill", feature.style.fill, editing, "color") : ""}
      <div class="panel-actions">
        ${editing ? `<button class="primary" type="submit">Save</button>` : `<button type="button" id="start-edit">Edit</button>`}
        <button type="button" id="shape-edit">Edit shape</button>
        <button type="button" class="danger" id="delete-feature">Delete</button>
      </div>
    </form>`);
  $("delete-feature").onclick = () => removeFeature(id);
  $("shape-edit").onclick = () => editShape(id);
  const edit = $("start-edit");
  if (edit) edit.onclick = () => openFeature(id, true);
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
    closePanel();
    loadFeatures();
  };
}

function fieldsFor(feature) {
  const defs = state.fieldDefs.filter((field) => field.x_type === feature.xType && field.visible);
  const source = defs.length ? defs : [
    { fieldname: "name", caption: "Name" },
    { fieldname: "comments", caption: "Comments" },
    { fieldname: "street", caption: "Street" },
    { fieldname: "city", caption: "City" },
    { fieldname: "installcompany", caption: "Install Company" },
    { fieldname: "installdate", caption: "Install Date" }
  ];
  return source
    .filter((field) => !["objectid", "ospgid", "miguid"].includes(field.fieldname))
    .map((field) => ({
      name: field.fieldname,
      caption: field.caption,
      value: displayValue(feature.properties[field.fieldname])
    }))
    .filter((field) => field.value || !/^ea\d+$/i.test(field.name));
}

function displayValue(value) {
  if (value && typeof value === "object") return value.xName || value.name || "";
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
  if (state.layer) state.layer.draw();
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

function setDrawMode(mode) {
  state.drawMode = mode;
  state.draft = [];
  if (state.preview) state.preview.setMap(null);
  state.preview = null;
  document.querySelectorAll("#draw-bar button").forEach((button) => {
    button.classList.toggle("active", button.dataset.draw === mode);
  });
  const drawing = mode !== "select";
  $("finish-draw").hidden = !drawing;
  $("cancel-draw").hidden = !drawing;
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

function openCreate(xType, geometry) {
  const style = { ...(state.styles[xType] || {}) };
  openPanel(`New ${label(xType)}`, `
    <form id="create-form">
      ${row("Name", "name", "", true)}
      ${row("Comments", "comments", "", true)}
      ${row("Street", "street", "", true)}
      ${row("City", "city", "", true)}
      ${row("Install company", "installcompany", "", true)}
      ${row("Stroke", "styleStroke", style.stroke || "#0B5394", true, "color")}
      ${style.fill ? row("Fill", "styleFill", style.fill, true, "color") : ""}
      <div class="panel-actions"><button class="primary" type="submit">Create</button></div>
    </form>`);
  $("create-form").onsubmit = async (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    const properties = {
      name: form.get("name"),
      comments: form.get("comments"),
      street: form.get("street"),
      city: form.get("city"),
      installcompany: form.get("installcompany")
    };
    const nextStyle = { ...style, stroke: form.get("styleStroke") || style.stroke };
    if (form.get("styleFill")) nextStyle.fill = form.get("styleFill");
    const created = await api("/api/features", {
      method: "POST",
      body: JSON.stringify({ networkId: state.network.id, xType, name: properties.name, geometry, properties, style: nextStyle })
    });
    state.selectedId = created.id;
    closePanel();
    if (state.map.getZoom() < 17) state.map.setZoom(17);
    state.map.panTo(created.centroid);
    loadFeatures();
  };
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

function openPanel(title, html) {
  $("panel-title").textContent = title;
  $("panel-body").innerHTML = html;
  $("float-panel").hidden = false;
}
function closePanel() { $("float-panel").hidden = true; }

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
  if (action === "clear-map") { state.visible = Object.fromEntries(Object.keys(state.visible).map((key) => [key, false])); loadFeatures(); }
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
  if (type) showCatalog("default_attribute", type);
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

function showLayers() {
  const keys = Object.keys(state.visible);
  openPanel("Layer Control", `
    <form id="layer-form">
      ${keys.map((key) => `<label class="check"><input type="checkbox" name="${key}" ${state.visible[key] ? "checked" : ""}> ${label(key)}</label>`).join("")}
      <div class="panel-actions"><button class="primary" type="submit">Update Map</button></div>
    </form>`);
  $("layer-form").onsubmit = (event) => {
    event.preventDefault();
    const form = new FormData(event.target);
    for (const key of keys) state.visible[key] = form.get(key) === "on";
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
      button.onclick = () => { $("search-results").innerHTML = ""; zoomToFeature(Number(button.dataset.id)); };
    });
  }, 250);
});

document.querySelectorAll("#draw-bar [data-draw]").forEach((button) => {
  button.onclick = () => setDrawMode(button.dataset.draw);
});
$("finish-draw").onclick = finishDraft;
$("cancel-draw").onclick = () => setDrawMode("select");
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
