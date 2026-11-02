// Perfiles de conexión a Attractor guardados en el equipo, como los de la CLI de Genesys
// (`gc profiles`). Uno por empresa: la aplicación API define la organización.
//
// Archivo: ~/.attractor/config.json (o $ATTRACTOR_CONFIG_DIR/config.json)
//   { "default": "acme", "profiles": { "acme": { base_url, client_id, client_secret,
//     organization, workspace, workspace_name, created_at } } }
//
// El secret queda en texto plano dentro de tu carpeta de usuario (igual que gc). En Linux y
// macOS el archivo se crea con permisos 600.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = process.env.ATTRACTOR_CONFIG_DIR || join(homedir(), ".attractor");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { default: null, profiles: {} };
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { default: cfg.default ?? null, profiles: cfg.profiles ?? {} };
  } catch {
    throw new Error(`No se pudo leer ${CONFIG_FILE}: el archivo está dañado.`);
  }
}

export function saveConfig(cfg) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows: sin efecto */ }
}

/** Perfil por nombre, o el por defecto. null si no hay ninguno. */
export function resolveProfile(name) {
  const cfg = loadConfig();
  const key = name || process.env.ATTRACTOR_PROFILE || cfg.default;
  if (!key) return null;
  const profile = cfg.profiles[key];
  if (!profile) {
    const names = Object.keys(cfg.profiles);
    throw new Error(`No existe el perfil "${key}".` +
      (names.length ? ` Perfiles: ${names.join(", ")}` : " Crea uno con: attractor login"));
  }
  return { name: key, ...profile };
}

/**
 * Rellena ATTRACTOR_* desde el perfil, sin pisar lo que ya venga del entorno o del .env.
 * Devuelve el nombre del perfil usado, o null.
 */
export function applyProfileToEnv(name) {
  const env = process.env;
  const hasAll = env.ATTRACTOR_BASE_URL && env.ATTRACTOR_CLIENT_ID && env.ATTRACTOR_CLIENT_SECRET;
  if (hasAll && !name) return null;
  const p = resolveProfile(name);
  if (!p) return null;
  const set = (k, v) => { if (v && (name || !env[k])) env[k] = v; };
  set("ATTRACTOR_BASE_URL", p.base_url);
  set("ATTRACTOR_CLIENT_ID", p.client_id);
  set("ATTRACTOR_CLIENT_SECRET", p.client_secret);
  set("ATTRACTOR_WORKSPACE", p.workspace);
  return p.name;
}

// ---------------------------------------------------------------- Token y workspaces

export async function fetchToken(baseUrl, clientId, clientSecret) {
  const res = await fetch(`${baseUrl}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`No se pudo obtener el token (${res.status}): ${body.error_description || body.error || "respuesta inesperada"}`);
  }
  const claims = JSON.parse(Buffer.from(body.access_token.split(".")[1], "base64url").toString());
  return { token: body.access_token, organization: claims.organization, expiresIn: body.expires_in };
}

export async function fetchWorkspaces(baseUrl, token, organization) {
  const res = await fetch(`${baseUrl}/api/workspaces?org_code=${organization}&page=1&limit=100`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    throw new Error(`No se pudieron listar los workspaces (${res.status}): ${body.error?.message || body.error || ""}`);
  }
  return (body.data ?? body).workspaces || [];
}
