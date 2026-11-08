import { test } from "node:test";
import assert from "node:assert/strict";
import { diffIntegrations, resolveIntegrations, validateIntegrationsSpec } from "../lib/integrations.mjs";

const KEY = "AIza" + "x".repeat(35);

test("la key de Maps se lee de api_key_env y solo se describe por su largo", () => {
  const r = resolveIntegrations({ google_maps: { api_key_env: "MAPS", region: "EC", language: "es" } }, { MAPS: KEY });
  assert.deepEqual(r.errors, []);
  assert.equal(r.patch.google_maps.api_key, KEY);
  assert.equal(r.patch.google_maps.region, "ec");
  assert.deepEqual(r.notes, [`Google Maps: key guardada (${KEY.length} car.)`]);
  assert.ok(!r.notes.join().includes(KEY));
});

test("key con formato inválido o ausente: error sin mostrar la key", () => {
  const bad = resolveIntegrations({ google_maps: { api_key_env: "MAPS" } }, { MAPS: "sk-no-es-google-123" });
  assert.match(bad.errors[0], /no tiene formato/);
  assert.ok(!bad.errors[0].includes("sk-no-es-google"));
  const missing = resolveIntegrations({ google_maps: { api_key_env: "MAPS" } }, {});
  assert.match(missing.errors[0], /falta la variable MAPS/);
});

test("la spec no acepta api_key en claro ni dominios con esquema", () => {
  const errs = validateIntegrationsSpec({ google_maps: { api_key: KEY }, scrape: { allow_hosts: ["https://x.com/a"] } });
  assert.ok(errs.some((e) => /la key no va en la spec/.test(e)));
  assert.ok(errs.some((e) => /no es un dominio/.test(e)));
});

test("diffIntegrations nombra cambios sin valores secretos", () => {
  const patch = resolveIntegrations({ google_maps: { api_key_env: "M", region: "co" }, scrape: { allow_hosts: ["a.com"] } }, { M: KEY }).patch;
  const diffs = diffIntegrations({ google_maps: { api_key: "AIza" + "y".repeat(35), region: "ec" } }, patch);
  assert.ok(diffs.some((d) => /cambiar key/.test(d)));
  assert.ok(diffs.some((d) => /region \(ec → co\)/.test(d)));
  assert.ok(diffs.some((d) => /dominios/.test(d)));
  assert.ok(!diffs.join().includes(KEY));
  assert.deepEqual(diffIntegrations({ ...patch }, patch), []);
});
