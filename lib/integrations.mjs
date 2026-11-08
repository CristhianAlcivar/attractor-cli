// Integraciones del agente que maneja la spec (srv_integrations en service-service):
//
//   integrations.google_maps  → tools geocode_location, search_nearby_places, find_nearest_place,
//                               calculate_route, get_place_details, generate_maps_link (mcp-server)
//   integrations.scrape       → web scraping limitado a allow_hosts
//
// La key de Google Maps NUNCA va en la spec: la spec dice en qué variable de entorno está
// (`api_key_env`) y aquí se lee. Nunca se imprime: en los mensajes sale "key guardada (N car.)".

export const MAPS_KEY_RE = /^AIza[\w-]{30,}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_RE = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Errores de forma (sin leer el entorno). Para validateSpec. */
export function validateIntegrationsSpec(intg) {
  const errors = [];
  if (intg === undefined) return errors;
  if (!intg || typeof intg !== "object" || Array.isArray(intg)) return ["integrations debe ser un objeto"];
  for (const k of Object.keys(intg)) {
    if (!["google_maps", "scrape"].includes(k)) errors.push(`integrations.${k}: no soportada (google_maps, scrape)`);
  }
  const m = intg.google_maps;
  if (m !== undefined) {
    if (!m || typeof m !== "object") errors.push("integrations.google_maps debe ser un objeto");
    else {
      for (const k of Object.keys(m)) {
        if (k === "api_key") errors.push("integrations.google_maps.api_key: la key no va en la spec; usa api_key_env con el nombre de la variable de entorno");
        else if (!["api_key_env", "region", "language", "rate_limit_per_minute"].includes(k)) errors.push(`integrations.google_maps.${k}: campo desconocido`);
      }
      if (!ENV_NAME_RE.test(m.api_key_env || "")) errors.push("integrations.google_maps.api_key_env: nombre de variable de entorno, p. ej. GOOGLE_MAPS_API_KEY");
      if (m.region !== undefined && !/^[a-z]{2}$/i.test(m.region)) errors.push("integrations.google_maps.region: código de país de 2 letras (ec, co, mx…)");
      if (m.language !== undefined && !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(m.language)) errors.push("integrations.google_maps.language: código BCP-47 (es, es-419…)");
      const rpm = m.rate_limit_per_minute;
      if (rpm !== undefined && (!Number.isInteger(rpm) || rpm < 1 || rpm > 6000)) errors.push("integrations.google_maps.rate_limit_per_minute: entero de 1 a 6000");
    }
  }
  const sc = intg.scrape;
  if (sc !== undefined) {
    if (!sc || typeof sc !== "object") errors.push("integrations.scrape debe ser un objeto");
    else {
      for (const k of Object.keys(sc)) {
        if (!["allow_hosts", "timeout_ms"].includes(k)) errors.push(`integrations.scrape.${k}: campo desconocido`);
      }
      if (!Array.isArray(sc.allow_hosts) || !sc.allow_hosts.length) errors.push("integrations.scrape.allow_hosts: lista de dominios permitidos (al menos uno)");
      for (const h of sc.allow_hosts || []) {
        if (!HOST_RE.test(String(h))) errors.push(`integrations.scrape.allow_hosts: "${h}" no es un dominio (sin https:// ni rutas)`);
      }
      if (sc.timeout_ms !== undefined && (!Number.isInteger(sc.timeout_ms) || sc.timeout_ms < 1000 || sc.timeout_ms > 120000)) {
        errors.push("integrations.scrape.timeout_ms: entero de 1000 a 120000");
      }
    }
  }
  return errors;
}

export const describeKey = (key) => (key ? `key guardada (${String(key).length} car.)` : "sin key");

/**
 * Lo que hay que escribir en srv_integrations según la spec, leyendo la key del entorno.
 * @returns {{ patch: object|null, errors: string[], notes: string[] }}
 */
export function resolveIntegrations(intg, env = process.env) {
  const errors = [];
  const notes = [];
  if (!intg) return { patch: null, errors, notes };
  const patch = {};

  if (intg.google_maps) {
    const m = intg.google_maps;
    const key = String(env[m.api_key_env] ?? "").trim();
    if (!key) {
      errors.push(`Google Maps: falta la variable ${m.api_key_env} (en el entorno o en el .env junto a la spec)`);
    } else if (!MAPS_KEY_RE.test(key)) {
      errors.push(`Google Maps: ${m.api_key_env} no tiene formato de API key de Google (AIza… y al menos 34 caracteres; tiene ${key.length})`);
    } else {
      patch.google_maps = {
        api_key: key,
        ...(m.language ? { language: m.language } : {}),
        ...(m.region ? { region: String(m.region).toLowerCase() } : {}),
        ...(m.rate_limit_per_minute !== undefined ? { rate_limit_per_minute: m.rate_limit_per_minute } : {}),
      };
      notes.push(`Google Maps: ${describeKey(key)}`);
    }
  }

  if (intg.scrape) {
    patch.scrape = {
      allow_hosts: [...new Set(intg.scrape.allow_hosts.map((h) => String(h).trim().toLowerCase()))],
      ...(intg.scrape.timeout_ms !== undefined ? { timeout_ms: intg.scrape.timeout_ms } : {}),
    };
    notes.push(`Web scraping: ${patch.scrape.allow_hosts.join(", ")}`);
  }

  return { patch: Object.keys(patch).length ? patch : null, errors, notes };
}

/** Qué cambia entre lo guardado y el patch, sin valores secretos. */
export function diffIntegrations(current, patch) {
  const cur = current || {};
  const diffs = [];
  if (patch?.google_maps) {
    const have = cur.google_maps || {};
    const want = patch.google_maps;
    if (!have.api_key) diffs.push(`Google Maps: activar (${describeKey(want.api_key)})`);
    else {
      if (have.api_key !== want.api_key) diffs.push(`Google Maps: cambiar key (${describeKey(want.api_key)})`);
      for (const k of ["language", "region", "rate_limit_per_minute"]) {
        if (want[k] !== undefined && String(have[k] ?? "") !== String(want[k])) diffs.push(`Google Maps: ${k} (${have[k] ?? "—"} → ${want[k]})`);
      }
    }
  }
  if (patch?.scrape) {
    const have = cur.scrape || {};
    const a = [...(have.allow_hosts || [])].map((h) => String(h).toLowerCase()).sort();
    const b = [...patch.scrape.allow_hosts].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`Web scraping: dominios (${a.join(", ") || "ninguno"} → ${b.join(", ")})`);
    if (patch.scrape.timeout_ms !== undefined && Number(have.timeout_ms) !== patch.scrape.timeout_ms) {
      diffs.push(`Web scraping: timeout_ms (${have.timeout_ms ?? "—"} → ${patch.scrape.timeout_ms})`);
    }
  }
  return diffs;
}
