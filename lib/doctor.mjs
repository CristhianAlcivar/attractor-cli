// attractor doctor <spec.json>: revisa, sin cambiar nada, que todo lo que la spec necesita esté
// en su lugar: token, workspace, agente, disparador HTTP, acciones de datos, tablas,
// integraciones y versión publicada frente al borrador. Nunca imprime secretos: de una key o
// un token solo se dice si existe y cuántos caracteres tiene.

import { findServiceByName, readAgent, resolveWorkspace, withListedFields } from "./api.mjs";
import { describeKey, MAPS_KEY_RE } from "./integrations.mjs";
import { DATA_TABLES_403, listTables } from "./tables.mjs";

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/**
 * @returns {Promise<Array<{ status: "ok"|"warn"|"fail", area: string, detail: string }>>}
 */
export async function runDoctor({ spec, client, wantedWorkspace = "", env = process.env, fetchImpl = globalThis.fetch }) {
  const checks = [];
  const add = (status, area, detail) => checks.push({ status, area, detail });
  const api = client.api;

  // 1. Token
  try {
    await client.getToken();
    const mins = client.state.expiresIn ? `, válido por ${Math.round(client.state.expiresIn / 60)} min` : "";
    add("ok", "Token", `aplicación API conectada${mins}`);
  } catch (err) {
    add("fail", "Token", `${err.message}. Revisa el client ID y el secret (attractor login).`);
    return checks;
  }

  // 2. Workspace
  try {
    const ws = await resolveWorkspace(client, wantedWorkspace);
    add("ok", "Workspace", `${ws.name}${ws.is_default ? " (por defecto)" : ""}`);
  } catch (err) {
    add("fail", "Workspace", err.status === 403 ? "sin permiso WORKSPACES (leer) en el rol de la aplicación API" : err.message);
    return checks;
  }

  // 3. Agente
  let agent = null;
  try {
    const found = await findServiceByName(api, spec.name);
    if (!found) {
      add("fail", "Agente", `no existe "${spec.name}" en este workspace (attractor apply lo crea)`);
    } else {
      agent = await readAgent(api, found.code);
      agent.service = withListedFields(agent.service, found);
      add("ok", "Agente", `"${spec.name}" (${found.code})${agent.prompt ? "" : " — sin prompt en la configuración"}`);
      if (!agent.prompt) add("fail", "Prompt", "la configuración del agente no tiene prompt");
    }
  } catch (err) {
    add("fail", "Agente", err.message);
  }

  if (agent) {
    // 4. Disparador HTTP
    const tr = agent.service.integrations?.http_trigger;
    const tokenLen = String(tr?.token || "").length;
    if (tr?.enabled && tokenLen >= 16) {
      add(tr.response_mode === "callback" ? "warn" : "ok", "Disparador HTTP",
        `encendido, token de ${tokenLen} car.${tr.response_mode === "callback" ? ", en modo callback (apply lo pasa a sync para probar)" : ""}`);
    } else {
      add("warn", "Disparador HTTP", `${tr?.enabled ? "encendido sin token válido" : "apagado"} (apply lo enciende para probar y lo apaga al terminar)`);
    }

    // 5. Publicado frente al borrador
    let pub = agent.service.publishedVersion;
    let pending = null;
    let publishedAt = null;
    try {
      const st = await api("GET", `/service/${agent.service.code}/publish-status`);
      pending = Boolean(st.has_unpublished_changes);
      publishedAt = st.published_at ?? null;
    } catch { /* endpoint no disponible: se informa solo la versión */ }
    const label = pub != null ? `versión ${pub}` : publishedAt ? "publicado" : null;
    const when = publishedAt ? ` (${String(publishedAt).slice(0, 16).replace("T", " ")} UTC)` : "";
    if (!label) add("warn", "Publicación", "nunca se publicó: el disparador y los canales no responden con este agente");
    else if (pending) add("warn", "Publicación", `${label}${when}; el borrador tiene cambios sin publicar (apply publica si la spec cambió algo)`);
    else add("ok", "Publicación", `${label}${when}${pending === false ? ", sin cambios pendientes" : ""}`);
  }

  // 6. Acciones de datos
  if (spec.tools?.length) {
    const linked = (agent?.prompt?.dataactions || []).map((d) => (typeof d === "string" ? { code: d } : d));
    for (const t of spec.tools) {
      let exists = null;
      try {
        const data = await api("GET", `/data-action?page=1&limit=50&search=${encodeURIComponent(t.name)}`);
        exists = (data.dataactions || data.items || []).find((d) => d.name === t.name) || null;
      } catch (err) {
        add("fail", "Acción de datos", `${t.name}: no se pudo consultar (${err.status === 403 ? "sin permiso DATA ACTION" : err.message})`);
        continue;
      }
      if (!exists) { add("fail", "Acción de datos", `${t.name}: no existe (attractor apply la crea)`); continue; }
      if (!agent) { add("ok", "Acción de datos", `${t.name}: existe`); continue; }
      const isLinked = linked.some((d) => d.code === exists.code || d.name === t.name);
      add(isLinked ? "ok" : "fail", "Acción de datos", `${t.name}: ${isLinked ? "existe y está enlazada" : "existe pero NO está enlazada al agente (el agente no puede usarla)"}`);
    }
    const extra = linked.filter((d) => d.name && !spec.tools.some((t) => t.name === d.name));
    if (extra.length) add("warn", "Acción de datos", `enlazadas que la spec no declara (apply las quita): ${extra.map((d) => d.name).join(", ")}`);
  }

  // 7. Tablas de datos
  if (spec.data_tables?.length) {
    let tables = null;
    try {
      tables = await listTables(api, client.state.workspace);
    } catch (err) {
      add("fail", "Tablas de datos", err.status === 403 ? DATA_TABLES_403 : err.message);
    }
    const linked = (agent?.prompt?.answers?.data_tables || []).map((x) => x?.code ?? x);
    for (const t of spec.data_tables) {
      const label = t.name || t.code;
      const found = tables?.find((x) => (t.code ? (x.dtb_code ?? x.code) === t.code : fold(x.dtb_name ?? x.name) === fold(t.name)));
      const code = t.code || found?.dtb_code || found?.code;
      if (tables && !found) {
        add("fail", "Tabla de datos", `${label}: no existe${t.code ? "" : " (attractor apply la crea desde el CSV)"}`);
        continue;
      }
      const rows = found?.dtb_row_count ?? found?.row_count;
      const searchable = (found?.dtb_columns || []).filter((c) => c.is_key).map((c) => c.key);
      const info = found ? ` (${rows ?? "?"} filas; busca por ${searchable.join(", ") || "ninguna columna"})` : "";
      if (!agent) { add(found ? "ok" : "warn", "Tabla de datos", `${label}${info}`); continue; }
      const isLinked = code && linked.includes(code);
      add(isLinked ? "ok" : "fail", "Tabla de datos", `${label}${info}: ${isLinked ? "enlazada" : "NO está enlazada al agente"}`);
    }
  }

  // 8. Integraciones
  const intg = agent?.service.integrations || {};
  const wantMaps = spec.integrations?.google_maps;
  if (wantMaps || intg.google_maps) {
    const saved = intg.google_maps?.api_key;
    const parts = [`key en el agente: ${saved ? `sí (${String(saved).length} car.)` : "no"}`];
    let status = saved ? "ok" : wantMaps ? "fail" : "warn";
    if (wantMaps) {
      const local = String(env[wantMaps.api_key_env] ?? "").trim();
      if (!local) { parts.push(`${wantMaps.api_key_env}: no definida`); if (!saved) status = "fail"; }
      else if (!MAPS_KEY_RE.test(local)) { parts.push(`${wantMaps.api_key_env}: formato inválido (${local.length} car.)`); status = "fail"; }
      else {
        parts.push(`${wantMaps.api_key_env}: ${describeKey(local)}`);
        if (saved && saved !== local) { parts.push("distinta de la del agente (apply la reemplaza)"); status = "warn"; }
      }
      const g = intg.google_maps || {};
      if (wantMaps.region && g.region !== String(wantMaps.region).toLowerCase()) parts.push(`región ${g.region || "—"} → ${String(wantMaps.region).toLowerCase()}`);
    } else if (intg.google_maps?.region) {
      parts.push(`región ${intg.google_maps.region}`);
    }
    add(status, "Google Maps", parts.join("; "));
  }
  const wantScrape = spec.integrations?.scrape;
  if (wantScrape || intg.scrape) {
    const have = (intg.scrape?.allow_hosts || []).map((h) => String(h).toLowerCase());
    const want = (wantScrape?.allow_hosts || []).map((h) => String(h).toLowerCase());
    const missing = want.filter((h) => !have.includes(h));
    const extra = wantScrape ? have.filter((h) => !want.includes(h)) : [];
    const detail = `dominios en el agente: ${have.join(", ") || "ninguno"}` +
      (missing.length ? `; faltan: ${missing.join(", ")}` : "") +
      (extra.length ? `; sobran: ${extra.join(", ")}` : "");
    add(missing.length || (wantScrape && !have.length) ? "fail" : extra.length ? "warn" : "ok", "Web scraping", detail);
  }

  // 9. Piper, si la spec prueba por voz
  if (spec.testing?.voice?.enabled) {
    const url = (spec.testing.voice.piper_url || env.PIPER_URL || "http://localhost:8100").replace(/\/+$/, "");
    try {
      const res = await fetchImpl(`${url}/health`);
      add(res.ok ? "ok" : "warn", "Piper", `${url} → HTTP ${res.status}`);
    } catch (err) {
      add("warn", "Piper", `${url} no responde (${err.message}); las pruebas de voz fallarán`);
    }
  }

  return checks;
}

export function formatChecks(checks) {
  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const w = Math.max(...checks.map((c) => c.area.length));
  const lines = checks.map((c) => `${icon[c.status]} ${c.area.padEnd(w)}  ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("", fails ? `✗ ${fails} problema(s)${warns ? ` y ${warns} aviso(s)` : ""}` : warns ? `✓ Sin problemas (${warns} aviso(s))` : "✓ Todo en orden");
  return lines.join("\n");
}
