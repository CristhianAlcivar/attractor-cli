// Pruebas del agente por el disparador HTTP (POST /api/agents/:code/trigger).
//
//   - Los casos de una corrida comparten conversación (mismo user_id), salvo que un caso pida
//     `new_conversation: true`: desde ese caso se usa un user_id nuevo.
//   - `--runs N` repite la suite N veces (cada corrida con conversación nueva) y un caso pasa si
//     aprueba al menos `pass_threshold` de las corridas (por defecto 2 de 3), porque el modelo no
//     responde siempre igual.
//   - `expect.called_tool` exige que el agente haya usado esa herramienta. El disparador no
//     devuelve trazas de herramientas: si la respuesta no las trae, se consultan los logs de
//     herramientas (`GET /api/tool-logs`); si tampoco están disponibles, el caso queda
//     «no verificable» (aviso, no falla).

export const REFUSAL = /\b(no (tengo|cuento con|dispongo|encuentro|encontr[eé]|s[eé]|puedo|manejo)|no est[aá] (en|dentro)|fuera de (mi|lo que)|no hay informaci[oó]n|sin informaci[oó]n|un asesor|una persona del equipo|i (don't|do not) (have|know)|not able to)\b/i;

export const DEFAULT_PASS_THRESHOLD = 2 / 3;

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/**
 * @param {string} reply
 * @param {object} expect
 * @param {{ toolCalls?: string[]|null }} ctx  null = no se sabe qué herramientas usó
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function checkExpectations(reply, expect = {}, { toolCalls = null } = {}) {
  const errors = [];
  const warnings = [];
  const text = fold(reply);
  for (const s of expect.contains || []) {
    if (!text.includes(fold(s))) errors.push(`debía contener «${s}»`);
  }
  if (expect.contains_any?.length && !expect.contains_any.some((s) => text.includes(fold(s)))) {
    errors.push(`debía contener alguna de: ${expect.contains_any.map((s) => `«${s}»`).join(", ")}`);
  }
  for (const s of expect.not_contains || []) {
    if (text.includes(fold(s))) errors.push(`no debía contener «${s}»`);
  }
  if (expect.matches && !new RegExp(expect.matches, "i").test(reply)) {
    errors.push(`no coincide con /${expect.matches}/i`);
  }
  if (expect.refuses === true && !REFUSAL.test(reply)) errors.push("debía reconocer que no sabe o declinar");
  if (expect.refuses === false && REFUSAL.test(reply)) errors.push("no debía declinar");
  if (expect.max_chars && reply.length > expect.max_chars) {
    errors.push(`demasiado larga (${reply.length} > ${expect.max_chars} caracteres)`);
  }
  const wanted = asList(expect.called_tool);
  if (wanted.length) {
    if (toolCalls == null) {
      warnings.push(`no verificable: no hay trazas de herramientas para comprobar ${wanted.join(", ")}`);
    } else {
      for (const name of wanted) {
        if (!toolCalls.includes(name)) {
          errors.push(`debía usar la herramienta ${name}` + (toolCalls.length ? ` (usó: ${toolCalls.join(", ")})` : " (no usó ninguna)"));
        }
      }
    }
  }
  return { errors, warnings };
}

/** Nombres de herramientas si la respuesta del disparador trae trazas; null si no las trae. */
export function extractToolCalls(data) {
  if (!data || typeof data !== "object") return null;
  const raw = data.tool_calls ?? data.tools_used ?? data.tools ?? data.trace?.tools ?? data.trace?.tool_calls;
  if (!Array.isArray(raw)) return null;
  return raw.map((t) => (typeof t === "string" ? t : t?.name ?? t?.tool ?? t?.function?.name)).filter(Boolean);
}

/**
 * Herramientas usadas desde `since`, según GET /api/tool-logs (logging-service). Devuelve null si
 * el endpoint no está disponible para esta aplicación (403/404). Los logs llegan con algo de
 * retraso: reintenta.
 */
export function createToolLogLookup(api, { serviceCode, sleep, delayMs = 1500, attempts = 3 }) {
  let unavailable = false;
  return async ({ tools, since, conversationId }) => {
    if (unavailable) return null;
    let names = [];
    for (let i = 0; i < attempts; i++) {
      await sleep(delayMs);
      let data;
      try {
        data = await api("GET", `/tool-logs?serviceId=${serviceCode}&startDate=${encodeURIComponent(since)}&limit=50`);
      } catch (err) {
        if ([401, 403, 404].includes(err.status)) { unavailable = true; return null; }
        return null;
      }
      const rows = data.rows || data.items || (Array.isArray(data) ? data : []);
      names = rows
        .filter((r) => {
          const conv = r.act_metadata?.conversation_id ?? r.act_metadata?.conversationId ?? r.conversation_id;
          return !conversationId || !conv || conv === conversationId;
        })
        .map((r) => r.act_resource_id ?? r.tool ?? r.tool_name)
        .filter(Boolean);
      if (tools.every((t) => names.includes(t))) break;
    }
    return names;
  };
}

/**
 * Qué hacer con el disparador HTTP antes de probar. Las pruebas necesitan que esté encendido,
 * con token de al menos 16 caracteres y en modo sync (en callback la respuesta no vuelve en la
 * llamada).
 * @returns {{ change: object|null, token: string, restore: object|null, why: string|null }}
 *   change  = http_trigger a guardar (null = ya sirve)
 *   restore = http_trigger a dejar al terminar (null = no tocar)
 */
export function triggerPlan(current, { keep = false, newToken }) {
  const tokenOk = String(current?.token || "").length >= 16;
  if (current?.enabled && tokenOk && current.response_mode !== "callback") {
    return { change: null, token: current.token, restore: null, why: null };
  }
  const token = tokenOk ? current.token : newToken();
  const change = { ...(current || {}), enabled: true, token, response_mode: "sync" };
  const why = !current?.enabled ? "estaba apagado" : !tokenOk ? "no tenía token" : "estaba en modo callback";
  // Encendido (en callback o sin token): se devuelve como estaba. Apagado: se apaga, salvo keep.
  const restore = current?.enabled ? { ...current } : keep ? null : { ...change, enabled: false };
  return { change, token, restore, why };
}

/** Pasadas mínimas: fracción (0–1] de las corridas, o un número entero de corridas. */
export function requiredPasses(runs, threshold = DEFAULT_PASS_THRESHOLD) {
  const th = Number(threshold);
  if (!(th > 0)) return runs;
  if (th > 1) return Math.min(runs, Math.ceil(th));
  return Math.max(1, Math.ceil(runs * th - 1e-9));
}

/**
 * Corre la suite.
 * @param {object} o
 * @param {Array} o.tests            [{ message, expect?, new_conversation?, pass_threshold? }]
 * @param {number} o.runs
 * @param {number} o.passThreshold
 * @param {(message, userId) => Promise<{reply, error?, toolCalls?, conversationId?, startedAt}>} o.trigger
 * @param {Function} [o.lookupTools]  createToolLogLookup(...)
 * @param {() => string} o.newUserId
 * @param {object} [o.voice]         { input(message, ctx) → texto que oye el agente, check(reply, test, ctx) → {errors, warnings} }
 * @param {string} o.agentName
 * @param {Function} o.log
 * @returns {{ failed: number, checked: number, unverifiable: number, results: Array }}
 */
export async function runSuite({ tests, runs = 1, passThreshold = DEFAULT_PASS_THRESHOLD, trigger, lookupTools, newUserId, voice, agentName = "Agente", log = () => {} }) {
  const results = tests.map(() => []);
  log(`\nPruebas (${tests.length}${runs > 1 ? ` × ${runs} corridas` : ""}):`);

  for (let run = 1; run <= runs; run++) {
    if (runs > 1) log(`\n— Corrida ${run}/${runs}`);
    let userId = newUserId();
    for (const [i, t] of tests.entries()) {
      if (t.new_conversation && i > 0) userId = newUserId();
      const ctx = { run, index: i };
      const heard = voice ? await voice.input(t.message, ctx) : t.message;
      const turn = await trigger(heard, userId);

      let toolCalls = turn.toolCalls ?? null;
      const wantedTools = asList(t.expect?.called_tool);
      if (wantedTools.length && toolCalls == null && lookupTools && turn.reply != null) {
        toolCalls = await lookupTools({ tools: wantedTools, since: turn.startedAt, conversationId: turn.conversationId });
      }

      let errors;
      let warnings = [];
      if (turn.reply == null) {
        errors = [`sin respuesta: ${turn.error ?? "el disparador no devolvió texto"}`];
      } else {
        ({ errors, warnings } = checkExpectations(turn.reply, t.expect, { toolCalls }));
        if (voice) {
          const v = await voice.check(turn.reply, t, ctx);
          errors.push(...v.errors);
          warnings.push(...v.warnings);
        }
      }
      const graded = Boolean(t.expect) || Boolean(voice);
      results[i].push({ ok: !errors.length, errors, warnings, reply: turn.reply, graded });

      const mark = !graded ? "·" : errors.length ? "✗" : "✓";
      log(`\n  ${mark} Cliente${t.new_conversation ? " (conversación nueva)" : ""}: ${t.message}`);
      if (heard !== t.message) log(`    Oído: ${heard}`);
      log(`    ${agentName}: ${turn.reply ?? "(nada)"}`);
      if (toolCalls?.length) log(`    Herramientas: ${toolCalls.join(", ")}`);
      for (const e of graded ? errors : []) log(`    ✗ ${e}`);
      for (const w of warnings) log(`    ⚠ ${w}`);
    }
  }

  let failed = 0;
  let checked = 0;
  let unverifiable = 0;
  const summary = [];
  for (const [i, t] of tests.entries()) {
    const rs = results[i];
    if (!rs.some((r) => r.graded)) continue;
    checked++;
    if (rs.some((r) => r.warnings.some((w) => w.startsWith("no verificable")))) unverifiable++;
    const passes = rs.filter((r) => r.ok).length;
    const need = requiredPasses(runs, t.pass_threshold ?? passThreshold);
    const ok = passes >= need;
    if (!ok) failed++;
    if (runs > 1) summary.push(`  ${ok ? "✓" : "✗"} ${passes}/${runs} (mínimo ${need}) · ${t.message}`);
  }
  if (summary.length) log(`\nResultado por caso:\n${summary.join("\n")}`);
  const unchecked = tests.length - checked;
  log(`\n${checked - failed}/${checked} pruebas con expectativa pasaron` +
    (unchecked ? ` (${unchecked} sin expectativa, solo para leer)` : "") +
    (unverifiable ? ` · ${unverifiable} con called_tool no verificable` : ""));
  return { failed, checked, unverifiable, results };
}
