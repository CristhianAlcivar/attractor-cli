import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../lib/api.mjs";
import { checkExpectations, createToolLogLookup, extractToolCalls, requiredPasses, runSuite, triggerPlan } from "../lib/testing.mjs";
import { mockFetch, noSleep } from "./mock-fetch.mjs";

let n = 0;
const newUserId = () => `u${++n}`;

test("new_conversation: el caso usa un user_id nuevo y los siguientes lo heredan", async () => {
  n = 0;
  const seen = [];
  await runSuite({
    tests: [
      { message: "hola" },
      { message: "mi pedido es P-1" },
      { message: "¿quién soy?", new_conversation: true, expect: { refuses: true } },
      { message: "sigo aquí" },
    ],
    trigger: async (message, userId) => { seen.push(userId); return { reply: "No tengo ese dato.", startedAt: "t" }; },
    newUserId,
  });
  assert.deepEqual(seen, ["u1", "u1", "u2", "u2"]);
});

test("--runs 3 con umbral 2 de 3: pasa si falla una corrida, falla si fallan dos", async () => {
  const flaky = (bad) => {
    let i = 0;
    return async () => ({ reply: bad.includes(++i) ? "Hola" : "Abrimos a las 9:00", startedAt: "t" });
  };
  const tests = [{ message: "¿horario?", expect: { contains: ["9:00"] } }];
  const one = await runSuite({ tests, runs: 3, trigger: flaky([2]), newUserId });
  assert.equal(one.failed, 0);
  const two = await runSuite({ tests, runs: 3, trigger: flaky([1, 3]), newUserId });
  assert.equal(two.failed, 1);
});

test("cada corrida empieza una conversación nueva", async () => {
  n = 0;
  const seen = [];
  await runSuite({
    tests: [{ message: "a" }, { message: "b" }],
    runs: 2,
    trigger: async (_m, userId) => { seen.push(userId); return { reply: "ok", startedAt: "t" }; },
    newUserId,
  });
  assert.deepEqual(seen, ["u1", "u1", "u2", "u2"]);
});

test("requiredPasses: fracción, entero y una sola corrida", () => {
  assert.equal(requiredPasses(3), 2);
  assert.equal(requiredPasses(1), 1);
  assert.equal(requiredPasses(5, 0.8), 4);
  assert.equal(requiredPasses(3, 3), 3);
  assert.equal(requiredPasses(2, 5), 2);
});

test("called_tool con trazas en la respuesta del disparador", () => {
  const calls = extractToolCalls({ reply: { text: "x" }, tool_calls: [{ name: "consultar_pedido" }] });
  assert.deepEqual(calls, ["consultar_pedido"]);
  assert.deepEqual(checkExpectations("Tu pedido va en camino", { called_tool: "consultar_pedido" }, { toolCalls: calls }).errors, []);
  const miss = checkExpectations("Tu pedido va en camino", { called_tool: "consultar_pedido" }, { toolCalls: [] });
  assert.match(miss.errors[0], /debía usar la herramienta consultar_pedido \(no usó ninguna\)/);
});

test("called_tool sin trazas: no verificable (aviso, no falla)", async () => {
  assert.equal(extractToolCalls({ reply: { text: "x" }, status: "answered" }), null);
  const r = await runSuite({
    tests: [{ message: "¿dónde está P-1?", expect: { called_tool: "consultar_pedido" } }],
    trigger: async () => ({ reply: "Va en camino", startedAt: "t" }),
    lookupTools: async () => null,
    newUserId,
  });
  assert.equal(r.failed, 0);
  assert.equal(r.unverifiable, 1);
});

test("called_tool desde /tool-logs cuando el disparador no trae trazas", async () => {
  const { fetch, calls } = mockFetch({
    "GET /api/tool-logs": () => ({ rows: [{ act_resource_id: "crear_ticket", act_action: "tool_executed" }], total: 1 }),
  });
  const c = createClient({ base: "https://x.test", clientId: "a", clientSecret: "b", fetch, sleep: noSleep });
  c.state.token = "t";
  const lookup = createToolLogLookup(c.api, { serviceCode: "s1", sleep: noSleep });
  const r = await runSuite({
    tests: [{ message: "abre un ticket", expect: { called_tool: "consultar_pedido" } }],
    trigger: async () => ({ reply: "Listo, ticket creado", startedAt: "2026-11-08T10:00:00.000Z" }),
    lookupTools: lookup,
    newUserId,
  });
  assert.equal(r.failed, 1, "usó otra herramienta");
  assert.equal(calls[0].query.serviceId, "s1");
  assert.equal(calls[0].query.startDate, "2026-11-08T10:00:00.000Z");
});

test("tool-logs con 403: deja de consultarlo y queda no verificable", async () => {
  const { fetch, calls } = mockFetch({ "GET /api/tool-logs": () => ({ status: 403, body: { success: false } }) });
  const c = createClient({ base: "https://x.test", clientId: "a", clientSecret: "b", fetch, sleep: noSleep });
  c.state.token = "t";
  const lookup = createToolLogLookup(c.api, { serviceCode: "s1", sleep: noSleep });
  assert.equal(await lookup({ tools: ["x"], since: "t" }), null);
  assert.equal(await lookup({ tools: ["x"], since: "t" }), null);
  assert.equal(calls.length, 1);
});

test("triggerPlan: apagado o sin token se enciende; ya listo no se toca", () => {
  const newToken = () => "n".repeat(48);
  const off = triggerPlan({ enabled: false, token: "t".repeat(20) }, { newToken });
  assert.equal(off.change.enabled, true);
  assert.equal(off.token, "t".repeat(20), "reutiliza el token si es válido");
  assert.equal(off.restore.enabled, false, "se apaga al terminar");

  const noToken = triggerPlan(undefined, { newToken });
  assert.equal(noToken.token, "n".repeat(48));
  assert.equal(noToken.change.response_mode, "sync");

  const keep = triggerPlan({ enabled: false }, { newToken, keep: true });
  assert.equal(keep.restore, null);

  const callback = triggerPlan({ enabled: true, token: "t".repeat(20), response_mode: "callback", callback_url: "https://cb" }, { newToken });
  assert.equal(callback.change.response_mode, "sync");
  assert.equal(callback.restore.response_mode, "callback", "vuelve a callback al terminar");

  const ready = triggerPlan({ enabled: true, token: "t".repeat(20), response_mode: "sync" }, { newToken });
  assert.equal(ready.change, null);
});

test("sin respuesta del disparador cuenta como fallo", async () => {
  const r = await runSuite({
    tests: [{ message: "hola", expect: { contains: ["hola"] } }],
    trigger: async () => ({ reply: null, error: "HTTP 503", startedAt: "t" }),
    newUserId,
  });
  assert.equal(r.failed, 1);
});
