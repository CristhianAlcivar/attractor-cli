#!/usr/bin/env node
// Aplica una especificación de agente (spec.json) en Attractor por la API pública.
// La spec es la fuente de verdad: si el agente no existe lo crea; si existe, calcula qué
// cambió y solo actualiza eso. Luego publica y corre las pruebas con sus expectativas.
//
//   acciones de datos → base de conocimiento → prompt → configuración → agente → publicar → probar
//
// Uso:
//   node apply-agent.mjs <spec.json> [--dry-run] [--test-only] [--runs N]
//
//   --dry-run    Muestra el plan sin escribir nada. Con credenciales compara contra lo que hay
//                en la plataforma; sin ellas muestra el plan de creación.
//   --test-only  No cambia nada: solo corre las pruebas contra la versión publicada.
//   --runs N     Repite las pruebas N veces; un caso pasa si aprueba pass_threshold de ellas
//                (por defecto 2 de 3).
//   --voice      Pruebas de voz con Piper (PIPER_URL, por defecto http://localhost:8100). Con
//                ATTRACTOR_STT_URL el agente recibe la transcripción del audio.
//
// Códigos de salida: 0 todo bien · 1 error · 2 alguna prueba falló o algo no quedó enlazado.
//
// Variables de entorno (o archivo .env junto al spec):
//   ATTRACTOR_BASE_URL       p. ej. https://attractoragents.com  (sin /api)
//   ATTRACTOR_CLIENT_ID      atr_...   (Administración → Usuarios y permisos → Aplicaciones API)
//   ATTRACTOR_CLIENT_SECRET  atrs_...
//   ATTRACTOR_WORKSPACE      opcional: nombre o código del workspace (sin él, el por defecto).
//
// Sin dependencias: Node 18+ (fetch, FormData y Blob nativos).

import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { applyProfileToEnv, normalizeBaseUrl } from "./profiles.mjs";
import {
  createClient, tokenOrganization, readService, serviceBody, findServiceByName as findService,
  configurationCodeOf,
} from "./lib/api.mjs";
import { writeVerified, mergeIntegrations } from "./lib/write.mjs";
import { validateIntegrationsSpec, resolveIntegrations, diffIntegrations } from "./lib/integrations.mjs";
import { applyDataTables, loadTable, validateDataTablesSpec } from "./lib/tables.mjs";
import { verifyLinks } from "./lib/verify.mjs";
import { parseArgs } from "./lib/args.mjs";
import { createVoiceRunner, DEFAULT_PIPER_URL } from "./lib/voice.mjs";
import { createToolLogLookup, extractToolCalls, runSuite, triggerPlan, DEFAULT_PASS_THRESHOLD } from "./lib/testing.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2), ["profile", "runs"]);
const PROFILE = typeof flags.profile === "string" ? flags.profile : undefined;
const [specPath] = positional;
const DRY_RUN = Boolean(flags["dry-run"]);
const TEST_ONLY = Boolean(flags["test-only"]);

if (!specPath) {
  console.error("Uso: node apply-agent.mjs <spec.json> [--dry-run] [--test-only] [--runs N] [--voice] [--profile <nombre>]");
  process.exit(1);
}
if (flags.runs !== undefined && !(Number.isInteger(Number(flags.runs)) && Number(flags.runs) >= 1 && Number(flags.runs) <= 10)) {
  console.error("✗ --runs es un entero de 1 a 10");
  process.exit(1);
}

const specDir = dirname(resolve(specPath));
loadDotEnv(resolve(specDir, ".env"));
// Credenciales: entorno → .env junto al spec → perfil (--profile, ATTRACTOR_PROFILE o el por
// defecto de `attractor login`). Con --profile explícito, el perfil manda.
try {
  const used = applyProfileToEnv(PROFILE);
  if (used) console.log(`· Perfil: ${used}`);
} catch (err) {
  fail(err.message);
}
const spec = JSON.parse(await readFile(specPath, "utf8"));

const BASE = normalizeBaseUrl(process.env.ATTRACTOR_BASE_URL || "");
const CLIENT_ID = process.env.ATTRACTOR_CLIENT_ID;
const CLIENT_SECRET = process.env.ATTRACTOR_CLIENT_SECRET;
const HAS_CREDENTIALS = Boolean(BASE && CLIENT_ID && CLIENT_SECRET);
let WORKSPACE = process.env.ATTRACTOR_WORKSPACE || "";

const PROMPT_KEYS = [
  "objective", "instructions", "tone", "language", "constraints",
  "initial_message", "scope_guard", "conversation_close_minutes",
];
const PROMPT_DEFAULTS = {
  instructions: "", tone: "", language: "es", constraints: "", initial_message: "",
  scope_guard: true, conversation_close_minutes: 10,
};
const NEW = "(nuevo)";
const WRITE_VERIFY_DELAY_MS = Number(process.env.ATTRACTOR_VERIFY_DELAY_MS ?? 2000);

validateSpec(spec);
const TESTS = normalizeTests(spec);

// Integraciones: la key de Maps sale del entorno (api_key_env). Nunca se imprime.
const INTEGRATIONS = resolveIntegrations(spec.integrations, process.env);
if (INTEGRATIONS.errors.length) {
  if (DRY_RUN) for (const e of INTEGRATIONS.errors) console.log(`⚠ ${e}`);
  else fail(INTEGRATIONS.errors.join("\n  "));
}

if (!DRY_RUN && !HAS_CREDENTIALS) {
  const missing = ["ATTRACTOR_BASE_URL", "ATTRACTOR_CLIENT_ID", "ATTRACTOR_CLIENT_SECRET"]
    .filter((k) => !process.env[k]);
  fail(`Faltan variables de entorno: ${missing.join(", ")}`);
}

// ---------------------------------------------------------------- HTTP

const client = createClient({ base: BASE, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, workspace: WORKSPACE, log });
const api = (...a) => client.api(...a);

async function getToken() {
  try {
    await client.getToken();
  } catch (err) {
    fail(err.message);
  }
}

// Toda escritura pasa por aquí: en --dry-run solo se anota en el plan.
const plan = [];
async function mutate(description, fn) {
  plan.push(description);
  if (DRY_RUN) {
    log(`  → ${description}`);
    return NEW;
  }
  const out = await fn();
  log(`✓ ${description}`);
  return out;
}

// Escritura + relectura: la API a veces responde 400/500 y sí guarda, o tarda en reflejarlo.
const verified = (label, write, read, expected) =>
  writeVerified({ label, write, read, expected, log, delayMs: WRITE_VERIFY_DELAY_MS });

// ---------------------------------------------------------------- Lecturas

// El panel no muestra el código del workspace: se resuelve por nombre (o el por defecto)
// con la organización que trae el propio token.
async function resolveWorkspace() {
  const wanted = WORKSPACE;
  const organization = tokenOrganization(client.state.token);
  WORKSPACE = "";
  client.state.workspace = "";
  const data = await api("GET", `/workspaces?org_code=${organization}&page=1&limit=100`);
  const list = data.workspaces || [];
  const ws = wanted
    ? list.find((w) => w.code === wanted || eq(w.name, wanted))
    : list.find((w) => w.is_default) || list[0];
  if (!ws) {
    fail(wanted
      ? `No existe el workspace "${wanted}". Disponibles: ${list.map((w) => w.name).join(", ")}`
      : "La organización no tiene workspaces.");
  }
  WORKSPACE = ws.code;
  client.state.workspace = ws.code;
  log(`· Workspace: ${ws.name} (${ws.code})`);
}

async function resolveModel() {
  const m = spec.model || {};
  if (m.code) return m.code;

  const providersData = await api("GET", "/provider");
  const providers = providersData.providers || providersData;
  const provider = providers.find((p) => eq(p.name, m.provider)) ||
    (m.provider ? null : providers[0]);
  if (!provider) fail(`No existe el proveedor "${m.provider}". Disponibles: ${providers.map((p) => p.name).join(", ")}`);

  const modelsData = await api("GET", `/model/provider/${provider.code}`);
  const models = modelsData.models || modelsData;
  const model = m.name ? models.find((x) => eq(x.name, m.name)) : models[0];
  if (!model) {
    fail(`No existe el modelo "${m.name ?? "(sin nombre)"}" en ${provider.name}. ` +
      `Disponibles: ${models.map((x) => x.name).join(", ")}`);
  }
  return model.code;
}

const findServiceByName = (name) => findService(api, name);

async function findKbByName(name) {
  const data = await api("GET", `/knowledge?page=1&limit=50&search=${encodeURIComponent(name)}`);
  return (data.knowledge_bases || []).find((k) => eq(k.name, name)) || null;
}

async function findDataActionByName(name) {
  const data = await api("GET", `/data-action?page=1&limit=50&search=${encodeURIComponent(name)}`);
  return (data.dataactions || data.items || []).find((d) => d.name === name) || null;
}

// ---------------------------------------------------------------- Acciones de datos

function dataActionBody(tool, existing) {
  const fields = (list) => (list || []).map((f) => ({
    name: f.name,
    type: f.type || "string",
    required: Boolean(f.required),
    description: f.description || "",
  }));
  return {
    name: tool.name,
    url: tool.url,
    method: tool.method,
    type: "BUSINESS",
    input_contract: fields(tool.input),
    output_contract: fields(tool.output),
    timeout: tool.timeout ?? 10,
    headers: tool.headers || [],
    query_strategy: tool.query_strategy || "auto",
    permission: tool.permission || "READ",
    ...(tool.requires_approval !== undefined ? { requires_approval: tool.requires_approval } : {}),
    auth_required: Boolean(tool.auth_profile),
    ...(tool.auth_profile ? { dat_auth_profile: tool.auth_profile } : {}),
    status: 1,
    // El enlace con prompts lo maneja el prompt (dataactions); al actualizar se conserva.
    ...(existing ? { prompts: existing.prompts || [] } : {}),
  };
}

function dataActionChanged(tool, d) {
  const want = dataActionBody(tool);
  const have = {
    url: d.url,
    method: String(d.method || "").toUpperCase(),
    input: normFields(d.inputContract),
    output: normFields(d.outputContract),
    timeout: Number(d.timeout ?? 10),
    query_strategy: d.queryStrategy || "auto",
    permission: d.permission || "READ",
    auth_profile: d.authProfile?.code ?? null,
    headers: JSON.stringify((d.headers || []).map((h) => [h.key, h.source, h.value ?? "", h.path ?? ""])),
  };
  const diffs = [];
  if (have.url !== want.url) diffs.push("url");
  if (have.method !== want.method) diffs.push("método");
  if (JSON.stringify(have.input) !== JSON.stringify(normFields(want.input_contract))) diffs.push("entrada");
  if (JSON.stringify(have.output) !== JSON.stringify(normFields(want.output_contract))) diffs.push("salida");
  if (have.timeout !== want.timeout) diffs.push("timeout");
  if (have.query_strategy !== want.query_strategy) diffs.push("query_strategy");
  if (have.permission !== want.permission) diffs.push("permiso");
  if (tool.requires_approval !== undefined && Boolean(d.requiresApproval) !== tool.requires_approval) diffs.push("aprobación");
  if ((tool.auth_profile ?? null) !== have.auth_profile) diffs.push("autenticación");
  const wantHeaders = JSON.stringify((want.headers || []).map((h) => [h.key, h.source, h.value ?? "", h.path ?? ""]));
  if (have.headers !== wantHeaders) diffs.push("headers");
  return diffs;
}

async function applyTools() {
  if (!spec.tools) return null; // la spec no maneja herramientas: no se tocan
  const codes = [];
  for (const tool of spec.tools) {
    const existing = HAS_CREDENTIALS ? await findDataActionByName(tool.name) : null;
    if (!existing) {
      const created = await mutate(`Acción de datos "${tool.name}" (${tool.method} ${tool.url}): crear`, () =>
        api("POST", "/data-action", { json: dataActionBody(tool) }));
      codes.push(created === NEW ? NEW : findCode(created));
      continue;
    }
    const diffs = dataActionChanged(tool, existing);
    if (diffs.length) {
      await mutate(`Acción de datos "${tool.name}": actualizar ${diffs.join(", ")}`, () =>
        api("PUT", `/data-action/${existing.code}`, { json: dataActionBody(tool, existing) }));
    } else {
      log(`· Acción de datos "${tool.name}": sin cambios`);
    }
    codes.push(existing.code);
  }
  return codes;
}

// ---------------------------------------------------------------- Base de conocimiento

async function applyKnowledgeBase() {
  const kb = spec.knowledge_base;
  if (!kb) return null; // la spec no maneja KB: no se toca
  if (kb.code) return [kb.code];

  const existing = HAS_CREDENTIALS ? await findKbByName(kb.name) : null;
  if (existing) {
    log(`· Base de conocimiento existente: ${existing.name} (${existing.code})`);
    if (hasContent(kb)) {
      log("  · ya existía: no vuelvo a subir documentos para no duplicarlos. Cámbialos desde el panel.");
    }
    return [existing.code];
  }

  const created = await mutate(`Base de conocimiento "${kb.name}": crear (${describeKb(kb)})`, () =>
    api("POST", "/knowledge", { json: { name: kb.name, description: kb.description || "", status: 1 } }));
  if (created === NEW) return [NEW];
  const kbCode = findCode(created);

  // Archivos (pdf, docx, txt, md, html): texto completo dentro del contexto (CAG, ~60.000 caracteres).
  for (const file of kb.files || []) {
    const path = resolve(specDir, file);
    const form = new FormData();
    form.append("file", new Blob([await readFile(path)]), basename(path));
    form.append("kb_code", kbCode);
    form.append("source", basename(path));
    const data = await api("POST", "/knowledge/document/ingest", { form });
    log(`  · archivo ${basename(path)}: ${data.chars ?? "?"} caracteres`);
  }

  for (const t of kb.texts || []) {
    await api("POST", "/knowledge/document", {
      json: { knowledge_base: kbCode, kind: "file", source: t.title, content: t.content, status: 1 },
    });
    log(`  · texto "${t.title}"`);
  }

  // Artículos: fragmentos con embeddings que el agente busca con search_knowledge.
  for (const a of kb.articles || []) {
    const doc = await api("POST", "/knowledge/document", {
      json: { knowledge_base: kbCode, kind: "article", source: a.title, status: 1 },
    });
    const docCode = findCode(doc);
    const chunks = splitText(a.content).map((kc_text) => ({ kc_document: docCode, kc_text }));
    await api("POST", "/knowledge/chunk/bulk", { json: chunks });
    log(`  · artículo "${a.title}": ${chunks.length} fragmentos`);
  }
  return [kbCode];
}

// ---------------------------------------------------------------- Prompt

// Respuestas del prompt que maneja la spec. Al crear se rellenan con los valores por
// defecto; al actualizar solo se tocan las claves que la spec trae.
function specAnswers({ withDefaults }) {
  const out = {};
  for (const k of PROMPT_KEYS) {
    if (spec[k] !== undefined) out[k] = spec[k];
    else if (withDefaults && k in PROMPT_DEFAULTS) out[k] = PROMPT_DEFAULTS[k];
  }
  if (spec.tools) {
    out.tool_guidance = Object.fromEntries(spec.tools.map((t) => [t.name, t.description]));
  }
  return out;
}

async function createPrompt(dataActionCodes, tableCodes) {
  const body = {
    name: spec.name,
    role: "system",
    type: "chat",
    max_tokens: spec.max_tokens ?? 1024,
    status: 1,
    dataactions: (dataActionCodes || []).filter((c) => c !== NEW),
    conclusions: [],
    content: "",
    template: "agent",
    // El prompt de tipo «agent» se guarda siempre con answers y objective.
    answers: {
      ...specAnswers({ withDefaults: true }),
      design_mode: "prompt",
      direction: "inbound",
      initiator: "human",
      send_data: false,
      trace_enabled: false,
      hide_ids_from_ai: true,
      knowledge_graph: { enabled: false, context: "" },
      data_tables: (tableCodes || []).filter((c) => c !== NEW),
    },
  };
  const data = await mutate(`Prompt "${spec.name}": crear`, () => api("POST", "/prompt", { json: body }));
  return data === NEW ? NEW : findCode(data);
}

async function updatePrompt(promptCode, dataActionCodes, tableCodes) {
  const current = await api("GET", `/prompt/${promptCode}`);
  const answers = current.answers || {};
  const wanted = specAnswers({ withDefaults: false });
  const diffs = [];
  const nextAnswers = { ...answers };

  for (const [k, v] of Object.entries(wanted)) {
    if (k === "tool_guidance") {
      const merged = { ...(answers.tool_guidance || {}), ...v };
      if (JSON.stringify(merged) !== JSON.stringify(answers.tool_guidance || {})) {
        diffs.push("guía de herramientas");
        nextAnswers.tool_guidance = merged;
      }
      continue;
    }
    if (JSON.stringify(answers[k]) !== JSON.stringify(v)) {
      diffs.push(k);
      nextAnswers[k] = v;
    }
  }

  // Tablas de datos: se enlazan en answers.data_tables (lista de códigos).
  if (tableCodes) {
    const have = [...(answers.data_tables || [])].map((t) => t?.code ?? t).sort();
    const want = [...new Set(tableCodes)].filter((c) => c !== NEW).sort();
    if (JSON.stringify(have) !== JSON.stringify(want) || tableCodes.includes(NEW)) {
      diffs.push(`tablas de datos (${have.length} → ${new Set(tableCodes).size})`);
      nextAnswers.data_tables = want;
    }
  }

  const body = {};
  const expected = {};
  if (diffs.length) {
    body.answers = nextAnswers;
    // Se verifica solo lo que la spec cambió: el backend puede normalizar el resto.
    expected.answers = Object.fromEntries([...Object.keys(wanted), "data_tables"]
      .filter((k) => JSON.stringify(answers[k]) !== JSON.stringify(nextAnswers[k]))
      .map((k) => [k, nextAnswers[k]]));
  }

  if (dataActionCodes) {
    const have = (current.dataactions || []).map((d) => d.code ?? d).sort();
    const want = [...new Set(dataActionCodes)].sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      diffs.push(`herramientas (${have.length} → ${want.length})`);
      body.dataactions = want.filter((c) => c !== NEW);
      expected.dataactions = body.dataactions;
    }
  }
  if (spec.max_tokens !== undefined && Number(current.max_tokens) !== spec.max_tokens) {
    diffs.push("max_tokens");
    body.max_tokens = spec.max_tokens;
    expected.max_tokens = spec.max_tokens;
  }

  if (!diffs.length) {
    log("· Prompt: sin cambios");
    return false;
  }
  await mutate(`Prompt: actualizar ${diffs.join(", ")}`, () => verified("Prompt",
    () => api("PUT", `/prompt/${promptCode}`, { json: body }),
    () => api("GET", `/prompt/${promptCode}`),
    expected));
  return true;
}

// ---------------------------------------------------------------- Configuración

async function createConfiguration(modelCode, promptCode) {
  // El nombre de la configuración es único en toda la plataforma: le agrego un sufijo.
  const name = `${spec.name} · ${randomBytes(3).toString("hex")}`;
  const data = await mutate(`Configuración "${name}": crear`, () => api("POST", "/configuration", {
    json: {
      name,
      model: modelCode,
      category: "chat",
      temperature: spec.temperature ?? 0.5,
      timezone: spec.timezone || "America/Guayaquil",
      status: 1,
      prompts: [promptCode],
    },
  }));
  return data === NEW ? NEW : findCode(data);
}

async function updateConfiguration(cfg) {
  const diffs = [];
  const next = {
    name: cfg.name,
    model: cfg.model?.code,
    temperature: Number(cfg.temperature),
    timezone: cfg.timezone,
    prompts: (cfg.prompts || []).map((p) => p.code),
    status: cfg.status ?? 1,
  };
  if (spec.model) {
    const modelCode = await resolveModel();
    if (modelCode !== next.model) { diffs.push("modelo"); next.model = modelCode; }
  }
  if (spec.temperature !== undefined && spec.temperature !== next.temperature) {
    diffs.push(`temperatura (${next.temperature} → ${spec.temperature})`);
    next.temperature = spec.temperature;
  }
  if (spec.timezone && spec.timezone !== next.timezone) {
    diffs.push("zona horaria");
    next.timezone = spec.timezone;
  }
  if (!diffs.length) {
    log("· Configuración: sin cambios");
    return false;
  }
  await mutate(`Configuración: actualizar ${diffs.join(", ")}`, () => verified("Configuración",
    () => api("PUT", `/configuration/${cfg.code}`, { json: next }),
    () => api("GET", `/configuration/${cfg.code}`),
    { model: { code: next.model }, temperature: next.temperature, timezone: next.timezone }));
  return true;
}

// ---------------------------------------------------------------- Agente (servicio)

// PUT /service con relectura. `patch.integrations` es un cambio parcial: se combina con lo
// guardado (el backend reemplaza el objeto entero) y se conserva http_trigger.
async function putService(service, patch) {
  const body = { ...patch };
  const expected = {};
  if (patch.integrations) {
    body.integrations = mergeIntegrations(service.integrations, patch.integrations);
    expected.integrations = patch.integrations;
  }
  if (patch.description !== undefined) expected.description = patch.description;
  if (patch.kbs) expected.kbs = patch.kbs;
  return verified("Agente",
    () => api("PUT", `/service/${service.code}`, { json: serviceBody(service, body) }),
    () => readService(api, service.code),
    expected);
}

async function createService(configurationCode, kbs) {
  const extras = [spec.channel && "desplegar en el canal", ...INTEGRATIONS.notes].filter(Boolean);
  const data = await mutate(`Agente "${spec.name}": crear${extras.length ? ` (${extras.join("; ")})` : ""}`, () =>
    api("POST", "/service", {
      json: {
        name: spec.name,
        description: spec.description || "",
        configuration: configurationCode,
        status: 1,
        kbs: (kbs || []).filter((c) => c !== NEW),
        ...(spec.channel ? { channel: spec.channel } : {}),
        ...(INTEGRATIONS.patch ? { integrations: INTEGRATIONS.patch } : {}),
      },
    }));
  return data === NEW ? NEW : (data.service?.code || findCode(data));
}

async function updateService(service, kbs) {
  const diffs = [];
  const patch = {};
  if (spec.description !== undefined && (service.description ?? "") !== spec.description) {
    diffs.push("descripción");
    patch.description = spec.description;
  }
  if (kbs) {
    const have = (service.kbs || []).map((k) => k.code).sort();
    const want = [...new Set(kbs)].sort();
    if (JSON.stringify(have) !== JSON.stringify(want)) {
      diffs.push("base de conocimiento");
      patch.kbs = want.filter((c) => c !== NEW);
    }
  }
  if (INTEGRATIONS.patch) {
    const intgDiffs = diffIntegrations(service.integrations, INTEGRATIONS.patch);
    if (intgDiffs.length) {
      diffs.push(...intgDiffs);
      patch.integrations = INTEGRATIONS.patch;
    } else {
      log(`· Integraciones: sin cambios (${INTEGRATIONS.notes.join("; ")})`);
    }
  }
  if (spec.channel && !(service.channels || []).some((c) => c.code === spec.channel)) {
    diffs.push("canal");
    patch.channel = spec.channel;
  }
  if (!diffs.length) {
    log("· Agente: sin cambios");
    return false;
  }
  await mutate(`Agente: actualizar ${diffs.join(", ")}`, () => putService(service, patch));
  return true;
}

async function publish(serviceCode) {
  const data = await mutate("Publicar", () => api("POST", `/service/${serviceCode}/publish`, { json: {} }));
  if (data !== NEW) log(`  · versión ${data.version ?? "?"}`);
}

// ---------------------------------------------------------------- Pruebas

// Enciende el disparador HTTP si está apagado, sin token válido o en modo callback (las pruebas
// necesitan la respuesta en la misma llamada). Devuelve el token y cómo dejarlo al terminar.
async function ensureTrigger(serviceCode) {
  const service = await readService(api, serviceCode);
  const p = triggerPlan(service.integrations?.http_trigger, {
    keep: Boolean(spec.http_trigger?.keep), newToken: () => randomBytes(24).toString("hex"),
  });
  if (!p.change) return { token: p.token, restore: null };
  await putService(service, { integrations: { http_trigger: p.change } });
  log(`· Disparador HTTP encendido para las pruebas (${p.why})`);
  return { token: p.token, restore: p.restore };
}

async function restoreTrigger(serviceCode, trigger) {
  const service = await readService(api, serviceCode);
  await putService(service, { integrations: { http_trigger: trigger } });
  log(trigger.enabled
    ? "· Disparador HTTP devuelto a su configuración anterior"
    : "· Disparador HTTP apagado (usa http_trigger.keep para dejarlo encendido)");
}

// Un turno por el disparador. El disparador no exige JWT: se autentica con X-Trigger-Token.
async function triggerTurn(serviceCode, token, message, userId) {
  const startedAt = new Date().toISOString();
  let res;
  let body = {};
  try {
    res = await fetch(`${BASE}/api/agents/${serviceCode}/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Trigger-Token": token },
      body: JSON.stringify({ message, user_id: userId }),
    });
    body = await res.json().catch(() => ({}));
  } catch (err) {
    return { reply: null, error: err.message, startedAt };
  }
  const data = body.data || {};
  return {
    reply: data.reply?.text ?? null,
    error: body.error?.message ?? body.error ?? (data.status === "human_in_charge" ? "un asesor tiene la conversación" : `HTTP ${res.status}`),
    toolCalls: extractToolCalls(data),
    conversationId: data.conversation_id ?? null,
    startedAt,
  };
}

// Pruebas de voz (--voice o testing.voice.enabled): Piper dice el mensaje y la respuesta.
function voiceRunner() {
  const cfg = spec.testing?.voice || {};
  if (!flags.voice && !cfg.enabled) return null;
  const sttEnv = cfg.stt_url_env || "ATTRACTOR_STT_URL";
  return createVoiceRunner({
    piperUrl: cfg.piper_url || process.env.PIPER_URL || DEFAULT_PIPER_URL,
    voice: cfg.voice,
    speed: cfg.speed,
    sttUrl: process.env[sttEnv] || null,
    language: cfg.language || "es-ES",
    outDir: resolve(specDir, cfg.out_dir || "voz-pruebas"),
    strict: cfg.strict !== false,
  });
}

async function runTests(serviceCode, token, voice) {
  const runs = Number(flags.runs ?? spec.testing?.runs ?? 1);
  if (voice) log(`\n· Pruebas de voz: ${voice.describe()}`);
  const { failed } = await runSuite({
    voice,
    tests: TESTS,
    runs,
    passThreshold: spec.testing?.pass_threshold ?? DEFAULT_PASS_THRESHOLD,
    trigger: (message, userId) => triggerTurn(serviceCode, token, message, userId),
    lookupTools: createToolLogLookup(api, { serviceCode, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) }),
    newUserId: () => `prueba-${randomBytes(4).toString("hex")}`,
    agentName: spec.name,
    log,
  });
  return failed;
}

// ---------------------------------------------------------------- Main

async function main() {
  if (DRY_RUN && !HAS_CREDENTIALS) return offlinePlan();

  await getToken();
  await resolveWorkspace();
  if (DRY_RUN) log("Simulación (--dry-run): no se escribe nada.\n");

  let service = await findServiceByName(spec.name);
  let serviceCode = service?.code;
  let changed = false;
  let links = null; // lo que la spec enlaza, para verificarlo al final

  if (TEST_ONLY) {
    if (!service) fail(`No existe el agente "${spec.name}" en este workspace.`);
  } else {
    const dataActionCodes = await applyTools();
    const kbs = await applyKnowledgeBase();
    const tableCodes = await applyDataTables(spec.data_tables, {
      api, workspace: WORKSPACE, specDir, mutate, log, NEW, offline: !HAS_CREDENTIALS,
    }).catch((err) => fail(err.message));
    links = {
      tools: (spec.tools || []).map((t, i) => ({ name: t.name, code: dataActionCodes?.[i] })),
      tables: (spec.data_tables || []).map((t, i) => ({ label: t.name || t.code, code: tableCodes?.[i] })),
      kbs: (kbs || []).filter((c) => c !== NEW),
      integrations: INTEGRATIONS.patch,
    };

    if (!service) {
      log(`· El agente "${spec.name}" no existe: se crea.`);
      const modelCode = await resolveModel();
      const promptCode = await createPrompt(dataActionCodes, tableCodes);
      const configurationCode = await createConfiguration(modelCode, promptCode);
      serviceCode = await createService(configurationCode, kbs);
      changed = true;
    } else {
      log(`· El agente "${spec.name}" existe (${service.code}): comparo con la spec.`);
      service = await readService(api, service.code);
      const cfg = await api("GET", `/configuration/${configurationCodeOf(service)}`);
      const promptCode = cfg.prompts?.[0]?.code;
      if (!promptCode) fail("La configuración del agente no tiene prompt; revísalo en el panel.");
      changed = (await updatePrompt(promptCode, dataActionCodes, tableCodes)) || changed;
      changed = (await updateConfiguration(cfg)) || changed;
      changed = (await updateService(service, kbs)) || changed;
      if (dataActionCodes && plan.some((p) => p.startsWith("Acción de datos"))) changed = true;
    }

    const neverPublished = service && service.publishedVersion == null;
    if (spec.publish === false) {
      log("· Sin publicar (publish: false)");
    } else if (changed || neverPublished) {
      await publish(serviceCode);
    } else {
      log("· Nada que publicar");
    }
  }

  if (DRY_RUN) {
    log(plan.length ? `\n${plan.length} cambio(s) pendiente(s).` : "\nLa plataforma ya coincide con la spec.");
    if (TESTS.length) log(`Al aplicar se correrían ${TESTS.length} prueba(s).`);
    return;
  }

  // Relee el agente y confirma que todo lo de la spec quedó enlazado.
  let missing = [];
  if (links) {
    const result = await verifyLinks(api, serviceCode, links);
    missing = result.missing;
    if (missing.length) {
      log(`\n✗ No quedó enlazado: ${missing.join("; ")}.`);
      log("  El agente no tiene esas herramientas o datos aunque la spec los declare: puede decir que");
      log("  los usó e inventar el resultado. Vuelve a aplicar la spec o enlázalos en el panel.");
    } else if (result.linked.length) {
      log(`· Verificado: ${result.linked.length} enlace(s) en su lugar (${result.linked.join("; ")})`);
    }
  }

  let failed = 0;
  if (TESTS.length) {
    const published = spec.publish !== false || (service && service.publishedVersion != null);
    if (!published) {
      log("· Pruebas omitidas: el agente no tiene versión publicada y el disparador usa esa.");
    } else {
      // Piper se comprueba antes de tocar el disparador: si no responde, no queda encendido.
      const voice = voiceRunner();
      if (voice) await voice.preflight().catch((err) => fail(err.message));
      const { token, restore } = await ensureTrigger(serviceCode);
      try {
        failed = await runTests(serviceCode, token, voice);
      } catch (err) {
        log(`✗ ${err.message}`);
        failed = Math.max(failed, 1);
      } finally {
        if (restore) await restoreTrigger(serviceCode, restore);
        else if (spec.http_trigger?.keep) {
          log(`· Disparador HTTP encendido: POST ${BASE}/api/agents/${serviceCode}/trigger (token en el panel)`);
        }
      }
    }
  }

  log("\nListo.");
  log(`  Agente: ${serviceCode}`);
  log(`  Probar: ${BASE}/agents/${serviceCode}/playground`);
  if (failed) log(`\n✗ ${failed} prueba(s) fallaron. Ajusta la spec y vuelve a aplicarla.`);
  if (missing.length) log(`\n✗ Falta enlazar: ${missing.join("; ")}`);
  if (failed || missing.length) process.exit(2);
}

function offlinePlan() {
  log("Simulación (--dry-run) sin credenciales: plan de creación.");
  log("  Con ATTRACTOR_* definidos, la simulación compara contra la plataforma.\n");
  for (const t of spec.tools || []) log(`  → Acción de datos "${t.name}" (${t.method} ${t.url})`);
  log(`  → Base de conocimiento: ${spec.knowledge_base ? describeKb(spec.knowledge_base) : "ninguna"}`);
  for (const t of spec.data_tables || []) {
    if (t.code) { log(`  → Tabla de datos existente ${t.code}: enlazar`); continue; }
    const { columns, rows } = loadTable(t, specDir);
    log(`  → Tabla de datos "${t.name}" desde ${t.csv}: ${columns.length} columnas, ${rows.length} filas`);
    for (const c of columns) log(`      · ${c.key} (${c.type}${c.is_key ? ", búsqueda exacta" : ""}) ← «${c.label}»`);
  }
  log(`  → Prompt "${spec.name}" — objetivo: ${spec.objective}`);
  log(`  → Configuración con el modelo ${JSON.stringify(spec.model || "(primer proveedor)")}`);
  log(`  → Agente "${spec.name}"${spec.channel ? ` desplegado en el canal ${spec.channel}` : ""}`);
  for (const n of INTEGRATIONS.notes) log(`  → Integración ${n}`);
  if (flags.voice || spec.testing?.voice?.enabled) log("  → Pruebas por voz con Piper");
  log(`  → ${spec.publish === false ? "Sin publicar" : "Publicar"}`);
  log(`  → Pruebas: ${TESTS.length} (${TESTS.filter((t) => t.expect).length} con expectativa)`);
}

main().catch((err) => fail(err.message));

// ---------------------------------------------------------------- Validación

// Valida lo mismo que agent-spec.schema.json, sin dependencias.
function validateSpec(s) {
  const errors = [];
  const allowed = new Set([
    "$schema", "name", "description", "objective", "instructions", "tone", "language", "constraints",
    "initial_message", "scope_guard", "conversation_close_minutes", "max_tokens", "model",
    "temperature", "timezone", "knowledge_base", "data_tables", "tools", "integrations", "channel", "publish", "http_trigger",
    "tests", "test_messages", "testing",
  ]);
  for (const k of Object.keys(s)) if (!allowed.has(k)) errors.push(`campo desconocido: ${k}`);

  if (!s.name || String(s.name).trim().length < 3) errors.push("name es obligatorio (mínimo 3 caracteres)");
  if (!s.objective || !String(s.objective).trim()) errors.push("objective es obligatorio");
  if (s.temperature !== undefined && !(s.temperature >= 0 && s.temperature <= 1)) {
    errors.push("temperature va de 0 a 1");
  }
  if (s.channel !== undefined && !isUuid(s.channel)) errors.push("channel debe ser un uuid");

  const kb = s.knowledge_base;
  if (kb && !kb.code && (!kb.name || kb.name.trim().length < 2)) {
    errors.push("knowledge_base.name es obligatorio (o usa knowledge_base.code de una existente)");
  }
  for (const f of kb?.files || []) {
    if (!/\.(pdf|docx|txt|md|html?)$/i.test(f)) errors.push(`tipo no soportado: ${f} (pdf, docx, txt, md, html)`);
    else if (!existsSync(resolve(specDir, f))) errors.push(`no existe el archivo ${f}`);
  }

  const names = new Set();
  for (const [i, t] of (s.tools || []).entries()) {
    const at = `tools[${i}]${t?.name ? ` (${t.name})` : ""}`;
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(t?.name || "")) errors.push(`${at}: name en snake_case, p. ej. consultar_pedido`);
    if (names.has(t?.name)) errors.push(`${at}: nombre repetido`);
    names.add(t?.name);
    if (!t?.description || t.description.length < 10) errors.push(`${at}: description debe decir cuándo usarla`);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(t?.method)) errors.push(`${at}: method inválido`);
    if (!/^https?:\/\//.test(t?.url || "")) errors.push(`${at}: url debe empezar por http(s)://`);
    if (t?.auth_profile !== undefined && !isUuid(t.auth_profile)) errors.push(`${at}: auth_profile debe ser un uuid`);
    for (const f of [...(t?.input || []), ...(t?.output || [])]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(f?.name || "")) errors.push(`${at}: campo con nombre inválido "${f?.name}"`);
    }
  }

  errors.push(...validateIntegrationsSpec(s.integrations));
  errors.push(...validateDataTablesSpec(s.data_tables, { exists: (f) => existsSync(resolve(specDir, f)) }));

  for (const [i, t] of (s.tests || []).entries()) {
    if (!t?.message) errors.push(`tests[${i}]: falta message`);
    if (t?.expect?.matches) {
      try { new RegExp(t.expect.matches); } catch { errors.push(`tests[${i}]: matches no es una regex válida`); }
    }
    for (const name of [].concat(t?.expect?.called_tool ?? [])) {
      if (typeof name !== "string" || !name) errors.push(`tests[${i}]: called_tool es el nombre de una herramienta (o una lista)`);
    }
    if (t?.new_conversation !== undefined && typeof t.new_conversation !== "boolean") errors.push(`tests[${i}]: new_conversation es true o false`);
    if (t?.pass_threshold !== undefined && !(Number(t.pass_threshold) > 0)) errors.push(`tests[${i}]: pass_threshold es una fracción (0.67) o un número de corridas (2)`);
  }
  const testing = s.testing;
  if (testing !== undefined) {
    if (!testing || typeof testing !== "object") errors.push("testing debe ser un objeto");
    else {
      for (const k of Object.keys(testing)) if (!["runs", "pass_threshold", "voice"].includes(k)) errors.push(`testing.${k}: campo desconocido`);
      const v = testing.voice;
      if (v !== undefined) {
        const keys = ["enabled", "piper_url", "voice", "speed", "stt_url_env", "language", "out_dir", "strict"];
        if (!v || typeof v !== "object") errors.push("testing.voice debe ser un objeto");
        else {
          for (const k of Object.keys(v)) if (!keys.includes(k)) errors.push(`testing.voice.${k}: campo desconocido`);
          if (v.piper_url !== undefined && !/^https?:\/\//.test(v.piper_url)) errors.push("testing.voice.piper_url debe empezar por http(s)://");
          if (v.speed !== undefined && !(v.speed > 0 && v.speed <= 3)) errors.push("testing.voice.speed va de 0 a 3");
          if (v.stt_url_env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(v.stt_url_env)) errors.push("testing.voice.stt_url_env es el nombre de una variable de entorno");
        }
      }
      if (testing.runs !== undefined && !(Number.isInteger(testing.runs) && testing.runs >= 1 && testing.runs <= 10)) errors.push("testing.runs es un entero de 1 a 10");
      if (testing.pass_threshold !== undefined && !(Number(testing.pass_threshold) > 0)) errors.push("testing.pass_threshold es una fracción (0.67) o un número de corridas (2)");
    }
  }

  if (errors.length) fail(`La spec no es válida:\n  - ${errors.join("\n  - ")}`);
}

function normalizeTests(s) {
  const tests = (s.tests || []).map((t) => ({
    message: t.message, expect: t.expect, new_conversation: t.new_conversation, pass_threshold: t.pass_threshold,
  }));
  for (const m of s.test_messages || []) tests.push({ message: m });
  return tests;
}

// ---------------------------------------------------------------- Utilidades

function normFields(list) {
  return (Array.isArray(list) ? list : []).map((f) => ({
    name: f.name, type: f.type || "string", required: Boolean(f.required), description: f.description || "",
  }));
}

function findCode(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.code === "string") return obj.code;
  if (typeof obj.kd_code === "string") return obj.kd_code;
  for (const v of Object.values(obj)) {
    const c = findCode(v);
    if (c) return c;
  }
  return null;
}

function splitText(text, max = 1500) {
  const paragraphs = String(text).split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && (current.length + p.length + 2) > max) {
      chunks.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${p}` : p;
  }
  if (current) chunks.push(current);
  return chunks;
}

function hasContent(kb) {
  return Boolean(kb.files?.length || kb.texts?.length || kb.articles?.length);
}

function describeKb(kb) {
  if (kb.code) return `existente ${kb.code}`;
  return `"${kb.name}" (${kb.files?.length ?? 0} archivos, ${kb.texts?.length ?? 0} textos, ` +
    `${kb.articles?.length ?? 0} artículos)`;
}

function fold(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function eq(a, b) {
  return fold(a).trim() === fold(b).trim();
}

function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v));
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
