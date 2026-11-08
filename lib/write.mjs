// Escrituras que se verifican leyendo.
//
// Algunas escrituras de la API (sobre todo PUT /api/prompt/:code) a veces responden 400/500 y
// aun así guardan, y la lectura justo después puede devolver el estado anterior (consistencia
// eventual). Por eso: escribir → esperar → leer → comparar. Solo es un fallo si lo leído no
// coincide con lo enviado.

import { defaultSleep } from "./api.mjs";

// Respuestas que con seguridad no guardaron: no vale la pena releer.
const DEFINITE_FAILURES = new Set([401, 403, 404, 409, 413, 422]);

/**
 * @param {object} o
 * @param {string} o.label             qué se escribe (para los mensajes)
 * @param {() => Promise<any>} o.write
 * @param {() => Promise<any>} o.read  lee el estado guardado
 * @param {any} o.expected             lo que debe verse al leer (subconjunto)
 * @returns {{ result, current, recovered }} recovered = la API respondió error pero guardó
 */
export async function writeVerified({
  label, write, read, expected, sleep = defaultSleep, log = () => {}, delayMs = 2000, attempts = 3,
}) {
  let result;
  let writeError = null;
  try {
    result = await write();
  } catch (err) {
    if (DEFINITE_FAILURES.has(err.status)) throw err;
    writeError = err;
  }

  let lastDiff = [];
  let readError = null;
  for (let i = 0; i < attempts; i++) {
    await sleep(delayMs);
    let current;
    try {
      current = await read();
    } catch (err) {
      readError = err;
      continue;
    }
    lastDiff = subsetDiff(expected, current);
    if (!lastDiff.length) {
      if (writeError) log(`  · ${label}: la API respondió ${writeError.status ?? "error"}, pero al releer quedó guardado`);
      return { result, current, recovered: Boolean(writeError) };
    }
  }

  const why = readError && !lastDiff.length
    ? `no se pudo releer (${readError.message})`
    : `lo guardado no coincide con lo enviado en: ${lastDiff.join(", ")}`;
  const err = new Error(`${label}: ${writeError ? `${writeError.message}; ` : ""}${why}`);
  err.status = writeError?.status ?? 0;
  throw err;
}

/**
 * Rutas donde `actual` no contiene lo de `expected`. Solo nombra campos, nunca valores (puede
 * haber keys). Arreglos se comparan como conjuntos de códigos: [{code:"a"}] equivale a ["a"].
 */
export function subsetDiff(expected, actual, path = "") {
  if (expected === undefined) return [];
  if (Array.isArray(expected)) {
    const norm = (list) => (Array.isArray(list) ? list : []).map(arrayItemKey).sort();
    return JSON.stringify(norm(expected)) === JSON.stringify(norm(actual)) ? [] : [path || "(raíz)"];
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object") return [path || "(raíz)"];
    return Object.keys(expected).flatMap((k) => subsetDiff(expected[k], actual[k], path ? `${path}.${k}` : k));
  }
  return sameScalar(expected, actual) ? [] : [path || "(raíz)"];
}

function arrayItemKey(x) {
  if (x && typeof x === "object") return x.code != null ? String(x.code) : stableStringify(x);
  return String(x);
}

function sameScalar(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return (a ?? null) === (b ?? null);
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return false;
}

export function stableStringify(v) {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * `PUT /api/service/:code` con `integrations` REEMPLAZA el objeto entero. Combina lo guardado
 * con el cambio (un nivel adentro de cada integración) y conserva `http_trigger` si el cambio
 * no lo trae.
 */
export function mergeIntegrations(current, patch = {}) {
  const base = current && typeof current === "object" ? current : {};
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object"
      ? { ...base[k], ...v }
      : v;
  }
  if (base.http_trigger && !("http_trigger" in patch)) out.http_trigger = base.http_trigger;
  return out;
}
