import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../lib/api.mjs";
import { formatChecks, runDoctor } from "../lib/doctor.mjs";
import { fakeJwt, mockFetch, noSleep } from "./mock-fetch.mjs";

const KEY_SAVED = "AIza" + "S".repeat(35);
const KEY_LOCAL = "AIza" + "L".repeat(35);
const TRIGGER_TOKEN = "secreto-del-disparador-123456";

const SPEC = {
  name: "Stela",
  tools: [{ name: "consultar_pedido" }, { name: "crear_ticket" }],
  data_tables: [{ name: "Agencias", csv: "agencias.csv" }],
  integrations: { google_maps: { api_key_env: "MAPS" }, scrape: { allow_hosts: ["tu-empresa.com", "blog.tu-empresa.com"] } },
};

function routes(over = {}) {
  return {
    "POST /api/oauth/token": () => ({ status: 200, body: { access_token: fakeJwt(), expires_in: 3600 } }),
    "GET /api/workspaces": () => ({ workspaces: [{ code: "ws-1", name: "Principal", is_default: true }] }),
    "GET /api/service": () => ({ services: [{ code: "s1", name: "Stela" }] }),
    "GET /api/service/s1": () => ({
      service: {
        code: "s1", name: "Stela", configuration: { code: "c1" }, publishedVersion: 4,
        integrations: {
          http_trigger: { enabled: false, token: TRIGGER_TOKEN },
          google_maps: { api_key: KEY_SAVED, region: "ec" },
          scrape: { allow_hosts: ["tu-empresa.com"] },
        },
      },
    }),
    "GET /api/service/s1/publish-status": () => ({ has_unpublished_changes: true }),
    "GET /api/configuration/c1": () => ({ code: "c1", prompts: [{ code: "p1" }] }),
    "GET /api/prompt/p1": () => ({ code: "p1", dataactions: [{ code: "da1", name: "consultar_pedido" }], answers: { data_tables: [] } }),
    "GET /api/data-action": (req) => ({ dataactions: [{ code: req.query.search === "crear_ticket" ? "da2" : "da1", name: req.query.search }] }),
    "GET /api/data-tables": () => [{ dtb_code: "tb1", dtb_name: "Agencias", dtb_row_count: 12, dtb_columns: [{ key: "ciudad", is_key: true }] }],
    ...over,
  };
}

async function doctor(over, env = { MAPS: KEY_LOCAL }) {
  const { fetch } = mockFetch(routes(over));
  const client = createClient({ base: "https://x.test", clientId: "atr_1", clientSecret: "atrs_super_secreto", fetch, sleep: noSleep });
  return runDoctor({ spec: SPEC, client, env });
}

test("doctor nombra lo que falta y nunca imprime secretos", async () => {
  const checks = await doctor();
  const out = formatChecks(checks);
  const by = (area) => checks.filter((c) => c.area === area);

  assert.equal(by("Token")[0].status, "ok");
  assert.equal(by("Agente")[0].status, "ok");
  assert.match(by("Disparador HTTP")[0].detail, /apagado/);
  assert.match(by("Publicación")[0].detail, /versión 4.*sin publicar/);
  assert.ok(by("Acción de datos").some((c) => c.status === "fail" && /crear_ticket.*NO está enlazada/.test(c.detail)));
  assert.ok(by("Tabla de datos").some((c) => c.status === "fail" && /Agencias \(12 filas; busca por ciudad\): NO está enlazada/.test(c.detail)));
  assert.match(by("Google Maps")[0].detail, /key en el agente: sí \(39 car\.\).*distinta/);
  assert.match(by("Web scraping")[0].detail, /faltan: blog\.tu-empresa\.com/);

  for (const secret of [KEY_SAVED, KEY_LOCAL, TRIGGER_TOKEN, "atrs_super_secreto"]) {
    assert.ok(!out.includes(secret), "no imprime secretos");
  }
  assert.match(out, /✗ \d+ problema\(s\)/);
});

test("doctor: 403 en tablas explica qué permiso falta", async () => {
  const checks = await doctor({ "GET /api/data-tables": () => ({ status: 403, body: { success: false } }) });
  assert.ok(checks.some((c) => c.area === "Tablas de datos" && /DATA TABLES/.test(c.detail)));
});

test("doctor: sin el agente avisa que apply lo crea", async () => {
  const checks = await doctor({ "GET /api/service": () => ({ services: [] }) });
  assert.match(checks.find((c) => c.area === "Agente").detail, /attractor apply lo crea/);
});

test("doctor: token inválido corta temprano", async () => {
  const checks = await doctor({ "POST /api/oauth/token": () => ({ status: 401, body: { error: "invalid_client" } }) });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, "fail");
});
