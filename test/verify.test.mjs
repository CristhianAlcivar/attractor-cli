import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../lib/api.mjs";
import { verifyLinks } from "../lib/verify.mjs";
import { mockFetch, noSleep } from "./mock-fetch.mjs";

function agentRoutes({ dataactions = [], data_tables = [], kbs = [], integrations = {} } = {}) {
  return {
    "GET /api/service/s1": () => ({
      service: { code: "s1", name: "Stela", configuration: { code: "c1" }, kbs, integrations },
      serviceChannel: null,
    }),
    "GET /api/configuration/c1": () => ({ code: "c1", prompts: [{ code: "p1" }] }),
    "GET /api/prompt/p1": () => ({ code: "p1", dataactions, answers: { objective: "x", data_tables } }),
  };
}

function api(routes) {
  const { fetch } = mockFetch(routes);
  const c = createClient({ base: "https://x.test", clientId: "a", clientSecret: "b", fetch, sleep: noSleep });
  c.state.token = "t";
  return c.api;
}

const WANT = {
  tools: [{ name: "consultar_pedido", code: "da1" }, { name: "crear_ticket", code: "da2" }],
  tables: [{ label: "Agencias", code: "tb1" }],
  kbs: ["kb1"],
  integrations: { google_maps: { api_key: "AIza..." }, scrape: { allow_hosts: ["tu-empresa.com"] } },
};

test("todo enlazado: missing vacío", async () => {
  const r = await verifyLinks(api(agentRoutes({
    dataactions: [{ code: "da1", name: "consultar_pedido" }, { code: "da2", name: "crear_ticket" }],
    data_tables: ["tb1"],
    kbs: [{ code: "kb1" }],
    integrations: { google_maps: { api_key: "AIzaX" }, scrape: { allow_hosts: ["tu-empresa.com"] } },
  })), "s1", WANT);
  assert.deepEqual(r.missing, []);
  assert.equal(r.linked.length, 6);
});

test("la acción que falló al enlazar (500 silencioso) aparece por nombre", async () => {
  const r = await verifyLinks(api(agentRoutes({
    dataactions: [{ code: "da1", name: "consultar_pedido" }],
    data_tables: [],
    kbs: [{ code: "kb1" }],
    integrations: { http_trigger: { enabled: true } },
  })), "s1", WANT);
  assert.deepEqual(r.missing, [
    'acción de datos "crear_ticket"',
    'tabla de datos "Agencias"',
    "integración Google Maps (key)",
    "integración Web scraping (tu-empresa.com)",
  ]);
});

test("acepta dataactions como lista de códigos", async () => {
  const r = await verifyLinks(api(agentRoutes({ dataactions: ["da1", "da2"] })), "s1", { tools: WANT.tools });
  assert.deepEqual(r.missing, []);
});
