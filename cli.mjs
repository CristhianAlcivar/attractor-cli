#!/usr/bin/env node
// CLI de Attractor para crear y mantener agentes desde una spec.
//
// Instalación (una vez, desde esta carpeta):   npm install -g .
//
//   attractor login [--profile <nombre>] [--url <base>] [--client-id <id>]
//   attractor profiles                 Lista los perfiles guardados
//   attractor use <perfil>             Cambia el perfil por defecto
//   attractor whoami [--profile p]     Comprueba la conexión
//   attractor logout [<perfil>]        Borra un perfil
//   attractor apply <spec.json> [--dry-run] [--test-only] [--runs N] [--voice] [--profile p]
//   attractor doctor <spec.json> [--profile p]   Revisa la spec contra la plataforma, sin cambiar nada
//   attractor init [carpeta]           Crea spec.json de ejemplo
//   attractor list [--workspace w] [--search t] [--json] [--profile p]   Lista todos los agentes
//
// Sin dependencias: Node 18+.

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {
  CONFIG_FILE, loadConfig, saveConfig, resolveProfile, fetchToken, fetchWorkspaces, normalizeBaseUrl,
  applyProfileToEnv,
} from "./profiles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_URL = "https://attractoragents.com";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = rest[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : rest[i + 1];
};
const positional = () => rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && /^--(profile|url|client-id|search|workspace|runs)$/.test(rest[i - 1])));

const commands = { login, profiles, use, whoami, logout, apply, doctor, init, list, agents: list, help };
const run = commands[cmd] || help;
run().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});

// ---------------------------------------------------------------- Comandos

async function login() {
  const cfg = loadConfig();
  const interactive = process.stdin.isTTY;
  if (!interactive && !process.env.ATTRACTOR_CLIENT_SECRET) {
    throw new Error("Sin consola interactiva: pasa --client-id y el secret en ATTRACTOR_CLIENT_SECRET.");
  }

  console.log("Conectar con Attractor (Administración → Usuarios y permisos → Aplicaciones API)\n");
  const baseUrl = normalizeBaseUrl(
    flag("url") || (interactive ? await ask(`URL de la plataforma [${DEFAULT_URL}]: `) : "") || DEFAULT_URL);
  console.log(`  · Plataforma: ${baseUrl}`);
  const clientId = (flag("client-id") || await ask("Client ID (atr_…): ")).trim();
  const clientSecret = (process.env.ATTRACTOR_CLIENT_SECRET || await askHidden("Client secret (atrs_…): ")).trim();
  if (!clientId || !clientSecret) throw new Error("Client ID y secret son obligatorios.");

  process.stdout.write("\nValidando… ");
  const { token, organization } = await fetchToken(baseUrl, clientId, clientSecret);
  console.log("ok");

  // El workspace es opcional: sin elegir, cada comando usa el por defecto de la organización.
  let workspace = null;
  if (interactive) {
    let list = [];
    try {
      list = await fetchWorkspaces(baseUrl, token, organization);
    } catch {
      /* sin permiso para listar: se usa el por defecto */
    }
    if (list.length > 1) {
      console.log("\nWorkspaces:");
      list.forEach((w, i) => console.log(`  ${i + 1}. ${w.name}${w.is_default ? "  (por defecto)" : ""}`));
      const answer = (await ask("Fijar uno (opcional) [Enter = el por defecto]: ")).trim();
      if (answer) {
        workspace = list[Number(answer) - 1];
        if (!workspace) throw new Error("Opción inválida.");
      }
    }
  }

  const suggested = slug(flag("profile") || workspace?.name || new URL(baseUrl).hostname.split(".")[0] || "default");
  const name = slug(flag("profile") || (interactive ? (await ask(`\nNombre del perfil [${suggested}]: `)).trim() : "") || suggested);
  if (cfg.profiles[name] && interactive && !flag("profile")) {
    const yes = (await ask(`Ya existe "${name}". ¿Reemplazarlo? [s/N]: `)).trim().toLowerCase();
    if (yes !== "s" && yes !== "si" && yes !== "sí") return console.log("Cancelado.");
  }

  cfg.profiles[name] = {
    base_url: baseUrl,
    client_id: clientId,
    client_secret: clientSecret,
    organization,
    workspace: workspace?.code ?? null,
    workspace_name: workspace?.name ?? null,
    created_at: new Date().toISOString(),
  };
  if (!cfg.default || Object.keys(cfg.profiles).length === 1) cfg.default = name;
  saveConfig(cfg);

  console.log(`\n✓ Perfil "${name}" guardado${cfg.default === name ? " (por defecto)" : ""} en ${CONFIG_FILE}`);
  if (cfg.default !== name) console.log(`  Para usarlo por defecto: attractor use ${name}`);
  console.log("  Siguiente: attractor init  →  edita spec.json  →  attractor apply spec.json --dry-run");
}

async function profiles() {
  const cfg = loadConfig();
  const names = Object.keys(cfg.profiles);
  if (!names.length) return console.log("No hay perfiles. Crea uno con: attractor login");
  for (const n of names) {
    const p = cfg.profiles[n];
    const mark = n === cfg.default ? "*" : " ";
    console.log(`${mark} ${n.padEnd(20)} ${p.base_url}  ${p.client_id}  workspace: ${p.workspace_name || "(por defecto)"}`);
  }
  console.log("\n* = por defecto. Cambia con: attractor use <perfil>");
}

async function use() {
  const [name] = positional();
  if (!name) throw new Error("Uso: attractor use <perfil>");
  const cfg = loadConfig();
  if (!cfg.profiles[name]) throw new Error(`No existe el perfil "${name}".`);
  cfg.default = name;
  saveConfig(cfg);
  console.log(`✓ Perfil por defecto: ${name}`);
}

async function whoami() {
  const p = resolveProfile(flag("profile"));
  if (!p) throw new Error("No hay perfiles. Crea uno con: attractor login");
  const { token, organization, expiresIn } = await fetchToken(p.base_url, p.client_id, p.client_secret);
  let ws = p.workspace_name || "(por defecto)";
  try {
    const list = await fetchWorkspaces(p.base_url, token, organization);
    const found = list.find((w) => w.code === p.workspace) || list.find((w) => w.is_default);
    if (found) ws = found.name;
  } catch { /* sin permiso de workspaces: se muestra lo guardado */ }
  console.log(`✓ Perfil ${p.name}: conectado a ${p.base_url}`);
  console.log(`  Aplicación: ${p.client_id}`);
  console.log(`  Organización: ${organization}`);
  console.log(`  Workspace: ${ws}`);
  if (expiresIn) console.log(`  Token válido por ${Math.round(expiresIn / 60)} min`);
}

async function logout() {
  const cfg = loadConfig();
  const [name = cfg.default] = positional();
  if (!name || !cfg.profiles[name]) throw new Error(`No existe el perfil "${name ?? ""}".`);
  delete cfg.profiles[name];
  if (cfg.default === name) cfg.default = Object.keys(cfg.profiles)[0] ?? null;
  saveConfig(cfg);
  console.log(`✓ Perfil "${name}" borrado.`);
  console.log("  El secret sigue activo en Attractor: regenéralo o borra la aplicación API si ya no se usa.");
}

async function apply() {
  if (!positional().length) throw new Error("Uso: attractor apply <spec.json> [--dry-run] [--test-only] [--runs N] [--voice] [--profile p]");
  const child = spawn(process.execPath, [join(HERE, "apply-agent.mjs"), ...rest], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}

async function doctor() {
  if (!positional().length) throw new Error("Uso: attractor doctor <spec.json> [--profile p]");
  const child = spawn(process.execPath, [join(HERE, "doctor.mjs"), ...rest], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}

// Credenciales con la misma prioridad que apply: --profile, variables ATTRACTOR_*, perfil por defecto.
async function connect() {
  applyProfileToEnv(flag("profile"));
  const baseUrl = normalizeBaseUrl(process.env.ATTRACTOR_BASE_URL || "");
  const clientId = process.env.ATTRACTOR_CLIENT_ID;
  const clientSecret = process.env.ATTRACTOR_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) throw new Error("No hay credenciales. Conéctate con: attractor login");
  const { token, organization } = await fetchToken(baseUrl, clientId, clientSecret);
  const workspaces = await fetchWorkspaces(baseUrl, token, organization);
  if (!workspaces.length) throw new Error("La organización no tiene workspaces.");

  const api = async (path, workspaceCode) => {
    const res = await fetch(`${baseUrl}/api${path}`, {
      headers: { Authorization: `Bearer ${token}`, "X-Workspace-Code": workspaceCode },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.success === false) {
      throw new Error(`GET /api${path} → ${res.status}: ${body.error?.message || body.error || ""}`);
    }
    return body.data ?? body;
  };
  return { baseUrl, workspaces, api };
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

// Todos los agentes de la organización, recorriendo cada workspace. --workspace limita a uno.
async function list() {
  const { baseUrl, workspaces, api } = await connect();
  const search = flag("search");
  const only = flag("workspace");
  const targets = only
    ? workspaces.filter((w) => w.code === only || fold(w.name) === fold(only))
    : workspaces;
  if (!targets.length) {
    throw new Error(`No existe el workspace "${only}". Disponibles: ${workspaces.map((w) => w.name).join(", ")}`);
  }

  const rows = [];
  for (const ws of targets) {
    const seen = [];
    for (let page = 1; page <= 50; page++) {
      const q = `page=${page}&limit=100${search ? `&search=${encodeURIComponent(search)}` : ""}`;
      const data = await api(`/service?${q}`, ws.code);
      const batch = data.services || data.items || [];
      seen.push(...batch);
      const total = Number(data.total ?? seen.length);
      if (!batch.length || seen.length >= total) break;
    }
    for (const s of seen) {
      rows.push({
        workspace: ws.name,
        name: s.name,
        code: s.code,
        published: s.publishedVersion ?? null,
        channels: (s.channels?.length ? s.channels : s.channel ? [s.channel] : [])
          .map((c) => c?.name || c?.provider || c?.code || c).filter(Boolean),
      });
    }
  }
  rows.sort((a, b) => a.workspace.localeCompare(b.workspace, "es") || String(a.name).localeCompare(String(b.name), "es"));

  if (rest.includes("--json")) return console.log(JSON.stringify(rows, null, 2));

  const scope = only ? `workspace ${targets[0].name}` : `${targets.length} workspace(s)`;
  console.log(`${rows.length} agente(s) en ${scope}${search ? ` que coinciden con «${search}»` : ""}`);
  if (!rows.length) return console.log("\nNo hay agentes. Crea uno con: attractor init  →  attractor apply spec.json");
  const w = Math.min(40, Math.max(6, ...rows.map((r) => String(r.name).length)));
  let current = null;
  for (const r of rows) {
    if (r.workspace !== current) {
      current = r.workspace;
      const count = rows.filter((x) => x.workspace === current).length;
      console.log(`\n${current} (${count})`);
      console.log(`  ${"Nombre".padEnd(w)}  ${"Publicado".padEnd(9)}  ${"Código".padEnd(36)}  Canales`);
    }
    const pub = r.published == null ? "no" : `v${r.published}`;
    const name = String(r.name).length > w ? String(r.name).slice(0, w - 1) + "…" : String(r.name);
    console.log(`  ${name.padEnd(w)}  ${pub.padEnd(9)}  ${String(r.code).padEnd(36)}  ${r.channels.join(", ") || "—"}`);
  }
  const empty = targets.filter((ws) => !rows.some((r) => r.workspace === ws.name)).map((ws) => ws.name);
  if (empty.length && !search) console.log(`\nSin agentes: ${empty.join(", ")}`);
  console.log(`\nAbrir uno: ${baseUrl}/agents/<código>/playground`);
}

async function init() {
  const [dir = "."] = positional();
  const target = resolve(dir);
  mkdirSync(target, { recursive: true });
  const spec = join(target, "spec.json");
  if (existsSync(spec)) throw new Error(`Ya existe ${spec}`);
  copyFileSync(join(HERE, "example-spec.json"), spec);
  copyFileSync(join(HERE, "agent-spec.schema.json"), join(target, "agent-spec.schema.json"));
  console.log(`✓ ${spec}`);
  console.log("  Edítala (el editor autocompleta con agent-spec.schema.json) y luego:");
  console.log("  attractor apply spec.json --dry-run");
}

async function help() {
  console.log(`attractor — crea y mantiene agentes de Attractor desde una spec

  attractor login [--profile <nombre>]      Guarda las credenciales de una aplicación API
  attractor profiles                        Lista los perfiles
  attractor use <perfil>                    Cambia el perfil por defecto
  attractor whoami [--profile p]            Comprueba la conexión
  attractor logout [<perfil>]               Borra un perfil
  attractor list [--workspace w] [--search t] [--json]
                                            Lista todos los agentes de la organización
  attractor init [carpeta]                  Crea una spec.json de ejemplo
  attractor apply <spec.json> [--dry-run] [--test-only] [--runs N] [--voice] [--profile p]
  attractor doctor <spec.json> [--profile p]
                                            Revisa agente, disparador, acciones, tablas e
                                            integraciones sin cambiar nada

Credenciales: con --profile manda ese perfil. Sin él: variables ATTRACTOR_*, .env junto a la
spec, ATTRACTOR_PROFILE o el perfil por defecto (${CONFIG_FILE}).`);
  if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exit(1);
}

// ---------------------------------------------------------------- Consola

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(question, (a) => { rl.close(); r(a); }));
}

// Lee sin mostrar lo que se escribe (muestra * por carácter).
function askHidden(question) {
  if (!process.stdin.isTTY) return ask(question);
  return new Promise((resolveAnswer) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolveAnswer(value);
        }
        if (ch === "\u0003") { process.stdout.write("\n"); process.exit(130); }
        if (ch === "\u007f" || ch === "\b") {
          if (value) { value = value.slice(0, -1); process.stdout.write("\b \b"); }
          continue;
        }
        value += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function slug(s) {
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "default";
}
