const OSP_REPORT_TYPES = [
  ["ap", "access_point"],
  ["bdg", "building"],
  ["cab", "cable"],
  ["db", "ductbank"],
  ["sp", "splice_point"],
  ["tp", "term_point"],
  ["sla", "slack"],
  ["pole", "pole"],
  ["pln", "mile_line"],
  [null, "spec"],
  [null, "route"]
];

function mapOspTypes(rows) {
  const found = new Map(rows.map((row) => [row.x_type, row]));
  return OSP_REPORT_TYPES.map(([xType, name]) => {
    const row = (xType && found.get(xType)) || {};
    return {
      name,
      x_type: xType,
      added: Number(row.added || 0),
      modified: Number(row.modified || row.updated || 0),
      total: Number(row.total || 0)
    };
  });
}

function sumModifyReport(payload) {
  const rows = Array.isArray(payload) ? payload : [];
  const first = rows[0]?.amList || [];
  const added = first.map(() => 0);
  const updated = first.map(() => 0);
  for (const row of rows) {
    (row.amList || []).forEach((item, index) => {
      added[index] += Number(item.added || 0);
      updated[index] += Number(item.updated || item.modified || 0);
    });
  }
  return first.map((item, index) => ({
    name: item.name,
    added: added[index],
    modified: updated[index],
    total: added[index] + updated[index]
  }));
}

const jar = new Map();
let cached = { token: "", at: 0 };

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
    return request(new URL(response.headers.get("location"), url).href, { method: "GET" }, hops + 1);
  }
  return response;
}

async function ospLogin() {
  if (cached.token && Date.now() - cached.at < 20 * 60 * 1000) return cached.token;
  const base = (process.env.OSP_BASE_URL || "http://103.84.132.26").replace(/\/$/, "");
  const clientId = process.env.OSP_CLIENT_ID;
  const clientSecret = process.env.OSP_CLIENT_SECRET;
  const username = process.env.OSP_USER || "Medianet_Edit";
  const password = process.env.OSP_PASSWORD || "";
  if (!password || !clientId || !clientSecret) return "";
  jar.clear();
  await request(`${base}/ospauth/OAuth/Authorize?scope=afo&client_id=${clientId}&redirect_uri=none&response_type=code`);
  const auth = await request(`${base}/OSPAuth/OAuth/Authenticate`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: username, password })
  });
  const html = await auth.text();
  const match = html.match(/CODE='([^']+)'/);
  if (!match || match[1] === "notauthorized") return "";
  const tokenResponse = await fetch(`${base}/ospauth/Ws/Token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookieHeader() },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: match[1],
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: "none"
    })
  });
  const tokenJson = await tokenResponse.json();
  const token = tokenJson?.data?.access_token || "";
  if (token) cached = { token, at: Date.now() };
  return token;
}

async function ospWs(pathname, body = null) {
  const token = await ospLogin();
  if (!token) return null;
  const base = (process.env.OSP_BASE_URL || "http://103.84.132.26").replace(/\/$/, "");
  const response = await fetch(base + pathname, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  if (!json) return null;
  return json.successful === false ? null : (json.data ?? json);
}

export async function fetchLiveOspReports() {
  const [counts, modify] = await Promise.all([
    ospWs("/OspReportsWs/GetAllNetworkCounts"),
    ospWs("/OspReportsWs/GetObjectModifyReport")
  ]);
  if (!counts && !modify) return null;
  return {
    source: "ospinsight",
    networks: Array.isArray(counts) ? counts.map((row) => ({
      name: row.network || row.name,
      count: Number(row.count || row.totalItems || 0)
    })) : [],
    types: modify ? sumModifyReport(modify) : []
  };
}

export { mapOspTypes };
