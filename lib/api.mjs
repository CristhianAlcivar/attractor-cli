// Cliente HTTP de la API pública de Attractor (/api/...) y lecturas que comparten apply,
// doctor y las pruebas. Recibe fetch y sleep inyectables para poder probarlo sin red.

export const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crea un cliente con token OAuth2 (client_credentials) y X-Workspace-Code.
 *   const client = createClient({ base, clientId, clientSecret });
 *   await client.getToken();
 *   await client.api("GET", "/service?page=1");
 */
export function createClient({
  base, clientId, clientSecret, workspace = "",
  fetch: fetchImpl = globalThis.fetch, sleep = defaultSleep, log = () => {},
}) {
  const state = { token: null, expiresIn: null, workspace };

  async function getToken() {
    const res = await fetchImpl(`${base}/api/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: "grant_type=client_credentials",
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const err = new Error(`No se pudo obtener el token (${res.status}): ${body.error_description || body.error || ""}`);
      err.status = res.status;
      throw err;
    }
    state.token = body.access_token;
    state.expiresIn = body.expires_in ?? null;
    return state.token;
  }

  async function api(method, path, { json, form, raw, headers = {}, retry = true } = {}) {
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${state.token}`,
        ...(state.workspace ? { "X-Workspace-Code": state.workspace } : {}),
        ...headers,
      },
    };
    if (json !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(json);
    } else if (form) {
      init.body = form; // fetch pone el boundary del multipart
    }
    const res = await fetchImpl(`${base}/api${path}`, init);
    if (res.status === 429 && retry) {
      const wait = Number(res.headers?.get?.("retry-after") || 30);
      log(`  · límite de peticiones; espero ${wait}s`);
      await sleep(wait * 1000);
      return api(method, path, { json, form, raw, headers, retry: false });
    }
    if (res.status === 401 && retry) {
      await getToken();
      return api(method, path, { json, form, raw, headers, retry: false });
    }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok || body.success === false) {
      const msg = body.error?.message || body.error || body.message || body.raw || "";
      const err = new Error(`${method} /api${path} → ${res.status}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
      err.status = res.status;
      throw err;
    }
    return raw ? body : (body.data ?? body);
  }

  return { state, getToken, api };
}

/** Organización del access token (claim `organization`). */
export function tokenOrganization(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()).organization ?? null;
  } catch {
    return null;
  }
}

/**
 * El panel no muestra el código del workspace: se resuelve por nombre o código (o el por
 * defecto) con la organización del token. Deja el código en client.state.workspace.
 */
export async function resolveWorkspace(client, wanted = "") {
  const organization = tokenOrganization(client.state.token);
  client.state.workspace = "";
  const data = await client.api("GET", `/workspaces?org_code=${organization}&page=1&limit=100`);
  const list = data.workspaces || [];
  const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
  const ws = wanted
    ? list.find((w) => w.code === wanted || fold(w.name) === fold(wanted))
    : list.find((w) => w.is_default) || list[0];
  if (!ws) {
    throw new Error(wanted
      ? `No existe el workspace "${wanted}". Disponibles: ${list.map((w) => w.name).join(", ")}`
      : "La organización no tiene workspaces.");
  }
  client.state.workspace = ws.code;
  return ws;
}

// ---------------------------------------------------------------- Agente (servicio)

/**
 * `GET /api/service/:code` responde `{ data: { service, serviceChannel?, webConfig? } }`, no el
 * servicio directo. Acepta también el servicio plano (lo que devuelve el listado).
 */
export function unwrapService(data) {
  if (data && typeof data === "object" && data.service && typeof data.service === "object") {
    return data.service;
  }
  return data;
}

export async function readService(api, code) {
  const service = unwrapService(await api("GET", `/service/${code}`));
  if (!service || typeof service !== "object" || !service.name) {
    throw new Error(`GET /api/service/${code} no devolvió un agente reconocible.`);
  }
  return service;
}

/**
 * `GET /api/service/:code` trae `publishedVersion: null` aunque el agente esté publicado; el
 * número real solo viene en el listado. Completa el detalle con lo del listado.
 */
export function withListedFields(service, listed) {
  if (!listed) return service;
  return { ...service, publishedVersion: service.publishedVersion ?? listed.publishedVersion ?? null };
}

export const configurationCodeOf = (service) =>
  service?.configuration?.code ?? (typeof service?.configuration === "string" ? service.configuration : null);

/**
 * Cuerpo de `PUT /api/service/:code`: exige `name` y `configuration`, y `kbs` reemplaza el
 * conjunto, así que se reenvía lo guardado más el cambio. `integrations` solo se envía si el
 * cambio la trae (sin enviarla, el backend no la toca).
 */
export function serviceBody(service, patch = {}) {
  const body = {
    name: service.name,
    configuration: configurationCodeOf(service),
    status: service.status ?? 1,
    description: service.description ?? "",
    kbs: (service.kbs || []).map((k) => k?.code ?? k),
    ...patch,
  };
  if (!body.name) throw new Error("PUT /service sin name: el agente leído no trae nombre.");
  if (!body.configuration) throw new Error("PUT /service sin configuration: el agente leído no trae configuración.");
  return body;
}

/** Busca el agente por nombre exacto en el workspace (el listado sí trae el servicio plano). */
export async function findServiceByName(api, name) {
  const data = await api("GET", `/service?page=1&limit=50&search=${encodeURIComponent(name)}`);
  return (data.services || data.items || []).find((s) => s.name === name) || null;
}

/** Agente + configuración + prompt, con los códigos ya resueltos. */
export async function readAgent(api, serviceCode) {
  const service = await readService(api, serviceCode);
  const cfgCode = configurationCodeOf(service);
  if (!cfgCode) throw new Error(`El agente ${serviceCode} no tiene configuración; revísalo en el panel.`);
  const configuration = await api("GET", `/configuration/${cfgCode}`);
  const promptCode = configuration.prompts?.[0]?.code ?? configuration.prompts?.[0] ?? null;
  const prompt = promptCode ? await api("GET", `/prompt/${promptCode}`) : null;
  return { service, configuration, prompt, promptCode };
}
