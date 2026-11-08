import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, readService, serviceBody } from "../lib/api.mjs";
import { mergeIntegrations, subsetDiff, writeVerified } from "../lib/write.mjs";
import { mockFetch, noSleep } from "./mock-fetch.mjs";

function client(routes) {
  const { fetch, calls } = mockFetch(routes);
  const c = createClient({ base: "https://x.test", clientId: "a", clientSecret: "b", fetch, sleep: noSleep });
  c.state.token = "t";
  return { ...c, calls };
}

test("PUT /prompt responde 500 pero guardó: no falla", async () => {
  let saved = { answers: { objective: "viejo" }, dataactions: [] };
  const c = client({
    "PUT /api/prompt/p1": (req) => {
      saved = { ...saved, ...req.body };
      return { status: 500, body: { success: false, error: "Internal" } };
    },
    "GET /api/prompt/p1": () => ({ ...saved, dataactions: saved.dataactions.map((code) => ({ code, name: code })) }),
  });
  const logs = [];
  const out = await writeVerified({
    label: "Prompt",
    write: () => c.api("PUT", "/prompt/p1", { json: { answers: { objective: "nuevo" }, dataactions: ["da1"] } }),
    read: () => c.api("GET", "/prompt/p1"),
    expected: { answers: { objective: "nuevo" }, dataactions: ["da1"] },
    sleep: noSleep,
    log: (m) => logs.push(m),
  });
  assert.equal(out.recovered, true);
  assert.match(logs.join("\n"), /respondió 500, pero al releer quedó guardado/);
});

test("PUT /prompt responde 400 y no guardó: falla nombrando el campo", async () => {
  const c = client({
    "PUT /api/prompt/p1": () => ({ status: 400, body: { success: false, error: "Bad" } }),
    "GET /api/prompt/p1": () => ({ answers: { objective: "viejo" } }),
  });
  await assert.rejects(
    writeVerified({
      label: "Prompt",
      write: () => c.api("PUT", "/prompt/p1", { json: { answers: { objective: "nuevo" } } }),
      read: () => c.api("GET", "/prompt/p1"),
      expected: { answers: { objective: "nuevo" } },
      sleep: noSleep,
    }),
    /Prompt: .*400.*answers\.objective/,
  );
});

test("consistencia eventual: la primera lectura viene vieja y la segunda ya no", async () => {
  let reads = 0;
  const waits = [];
  const out = await writeVerified({
    label: "Prompt",
    write: async () => ({ ok: true }),
    read: async () => (++reads === 1 ? { max_tokens: 512 } : { max_tokens: 1024 }),
    expected: { max_tokens: 1024 },
    sleep: async (ms) => waits.push(ms),
    delayMs: 2000,
  });
  assert.equal(out.recovered, false);
  assert.deepEqual(waits, [2000, 2000]);
});

test("un 403 no se relee: falla de inmediato", async () => {
  let reads = 0;
  const err = Object.assign(new Error("PUT → 403"), { status: 403 });
  await assert.rejects(writeVerified({
    label: "x", write: async () => { throw err; }, read: async () => { reads++; return {}; }, expected: {}, sleep: noSleep,
  }), /403/);
  assert.equal(reads, 0);
});

test("subsetDiff compara arreglos como conjuntos de códigos y números con tolerancia de tipo", () => {
  assert.deepEqual(subsetDiff({ dataactions: ["a", "b"] }, { dataactions: [{ code: "b" }, { code: "a" }] }), []);
  assert.deepEqual(subsetDiff({ temperature: 0.5 }, { temperature: "0.5" }), []);
  assert.deepEqual(subsetDiff({ integrations: { google_maps: { region: "co" } } }, { integrations: {} }), ["integrations.google_maps"]);
});

test("mergeIntegrations conserva http_trigger y lo demás", () => {
  const current = {
    http_trigger: { enabled: true, token: "t".repeat(20), created_at: "2026-01-01" },
    smtp: { host: "h", from: "f" },
    google_maps: { api_key: "AIzaOLD", language: "es" },
  };
  const out = mergeIntegrations(current, { google_maps: { region: "ec" }, scrape: { allow_hosts: ["a.com"] } });
  assert.deepEqual(out.http_trigger, current.http_trigger);
  assert.deepEqual(out.smtp, current.smtp);
  assert.deepEqual(out.google_maps, { api_key: "AIzaOLD", language: "es", region: "ec" });
  assert.deepEqual(out.scrape, { allow_hosts: ["a.com"] });
});

test("PUT /service con integraciones envía el objeto combinado completo", async () => {
  const service = {
    code: "s1", name: "Stela", configuration: { code: "c1" }, kbs: [],
    integrations: { http_trigger: { enabled: true, token: "x".repeat(24) } },
  };
  let stored = service;
  const c = client({
    "PUT /api/service/s1": (req) => { stored = { ...stored, integrations: req.body.integrations }; return { service: stored }; },
    "GET /api/service/s1": () => ({ service: stored }),
  });
  const body = serviceBody(service, { integrations: mergeIntegrations(service.integrations, { scrape: { allow_hosts: ["x.com"] } }) });
  await c.api("PUT", "/service/s1", { json: body });
  const after = await readService(c.api, "s1");
  assert.equal(after.integrations.http_trigger.enabled, true, "no se pierde el disparador");
  assert.deepEqual(after.integrations.scrape.allow_hosts, ["x.com"]);
  assert.equal(c.calls[0].body.name, "Stela");
});
