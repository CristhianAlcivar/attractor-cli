// fetch simulado para las pruebas: rutas "MÉTODO /ruta" → handler(req) que devuelve
// { status?, body?, headers? } o directamente el `data` (se envuelve en { success, data }).
// Guarda cada llamada en `calls` con el cuerpo ya parseado.

export function mockFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    let body = init.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* form-urlencoded u otro texto */ }
    }
    const call = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers || {}, body, rawBody: init.body };
    calls.push(call);

    const key = `${method} ${u.pathname}`;
    const entry = Object.entries(routes).find(([pattern]) => matches(pattern, key));
    if (!entry) return response(404, { success: false, error: `sin ruta simulada: ${key}` });
    const out = await entry[1](call);
    if (out && typeof out === "object" && ("status" in out || "body" in out)) {
      return response(out.status ?? 200, out.body ?? {}, out.headers, out.rawBytes);
    }
    return response(200, { success: true, data: out, error: null });
  };
  return { fetch, calls };
}

// "GET /api/service/:id" coincide con "GET /api/service/abc".
function matches(pattern, key) {
  const re = new RegExp("^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-z_]+/gi, "[^/]+") + "$", "i");
  return re.test(key);
}

function response(status, body, headers = {}, rawBytes) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => text,
    json: async () => JSON.parse(text),
    arrayBuffer: async () => (rawBytes ? rawBytes.buffer.slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength) : new TextEncoder().encode(text).buffer),
  };
}

export const noSleep = async () => {};

/** Un JWT sin firma con el claim organization, para tokenOrganization(). */
export function fakeJwt(payload = { organization: "org-1" }) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(payload)}.x`;
}
