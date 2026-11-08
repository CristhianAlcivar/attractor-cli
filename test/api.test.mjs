import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, readService, readAgent, serviceBody, unwrapService, withListedFields } from "../lib/api.mjs";
import { mockFetch, noSleep } from "./mock-fetch.mjs";

const SERVICE = {
  code: "srv-1",
  name: "Stela",
  status: 1,
  description: "",
  configuration: { code: "cfg-1", name: "Stela · abc" },
  kbs: [{ code: "kb-1", name: "KB" }],
  integrations: { http_trigger: { enabled: true, token: "x".repeat(24) } },
};

function client(routes) {
  const { fetch, calls } = mockFetch(routes);
  const c = createClient({ base: "https://x.test", clientId: "atr_1", clientSecret: "atrs_1", workspace: "ws-1", fetch, sleep: noSleep });
  c.state.token = "t";
  return { ...c, calls };
}

test("unwrapService acepta { service, serviceChannel } y el servicio plano", () => {
  assert.equal(unwrapService({ service: SERVICE, serviceChannel: { code: "sc" } }).code, "srv-1");
  assert.equal(unwrapService(SERVICE).code, "srv-1");
});

test("readService lee data.service de GET /service/:code", async () => {
  const c = client({ "GET /api/service/srv-1": () => ({ service: SERVICE, serviceChannel: { code: "sc-1" } }) });
  const s = await readService(c.api, "srv-1");
  assert.equal(s.name, "Stela");
  assert.equal(s.configuration.code, "cfg-1");
  assert.equal(c.calls[0].headers["X-Workspace-Code"], "ws-1");
});

test("readAgent pide /configuration/<code> (nunca /configuration/undefined)", async () => {
  const c = client({
    "GET /api/service/srv-1": () => ({ service: SERVICE }),
    "GET /api/configuration/:id": (req) => {
      assert.equal(req.path, "/api/configuration/cfg-1");
      return { code: "cfg-1", prompts: [{ code: "prm-1" }] };
    },
    "GET /api/prompt/prm-1": () => ({ code: "prm-1", answers: {}, dataactions: [] }),
  });
  const agent = await readAgent(c.api, "srv-1");
  assert.equal(agent.promptCode, "prm-1");
  assert.ok(!c.calls.some((x) => x.path.includes("undefined")));
});

test("serviceBody manda name y configuration del servicio leído", () => {
  const body = serviceBody(SERVICE, { description: "nueva" });
  assert.equal(body.name, "Stela");
  assert.equal(body.configuration, "cfg-1");
  assert.deepEqual(body.kbs, ["kb-1"]);
  assert.equal(body.description, "nueva");
  assert.equal("integrations" in body, false, "sin cambio de integraciones no se envían");
});

test("serviceBody falla en vez de mandar un PUT sin name", () => {
  assert.throws(() => serviceBody({ configuration: { code: "c" } }), /sin name/);
});

test("withListedFields toma publishedVersion del listado (el detalle trae null)", () => {
  const s = withListedFields({ ...SERVICE, publishedVersion: null }, { code: "srv-1", publishedVersion: 2 });
  assert.equal(s.publishedVersion, 2);
  assert.equal(withListedFields({ ...SERVICE, publishedVersion: null }, { publishedVersion: null }).publishedVersion, null);
});

test("api reintenta con token nuevo tras un 401", async () => {
  let n = 0;
  const c = client({
    "POST /api/oauth/token": () => ({ status: 200, body: { access_token: "t2", expires_in: 3600 } }),
    "GET /api/service/srv-1": () => (++n === 1 ? { status: 401, body: { success: false } } : { service: SERVICE }),
  });
  const s = await readService(c.api, "srv-1");
  assert.equal(s.code, "srv-1");
  assert.equal(c.state.token, "t2");
});
