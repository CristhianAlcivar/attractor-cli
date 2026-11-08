import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "../lib/api.mjs";
import { applyDataTables, loadTable, validateDataTablesSpec } from "../lib/tables.mjs";
import { mockFetch, noSleep } from "./mock-fetch.mjs";

const dir = mkdtempSync(join(tmpdir(), "attractor-tables-"));
writeFileSync(join(dir, "agencias.csv"), "Ciudad,Dirección,Teléfono\nquito,Av. Amazonas 123,022345678\nguayaquil,Malecón 456,042345678\n");

const ctx = (api) => ({ api, workspace: "ws-1", specDir: dir, log: () => {}, NEW: "(nuevo)", mutate: (_d, fn) => fn() });

function client(routes) {
  const { fetch, calls } = mockFetch(routes);
  const c = createClient({ base: "https://x.test", clientId: "a", clientSecret: "b", fetch, sleep: noSleep });
  c.state.token = "t";
  return { ...c, calls };
}

test("loadTable marca searchable_columns como is_key y deja el teléfono como texto", () => {
  const { columns, rows } = loadTable({ name: "Agencias", csv: "agencias.csv", searchable_columns: ["ciudad"] }, dir);
  assert.deepEqual(columns.map((c) => [c.key, c.is_key, c.type]), [
    ["ciudad", true, "text"], ["direccion", false, "text"], ["telefono", false, "text"],
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].telefono, "022345678");
});

test("searchable_columns inexistente: error con las columnas disponibles", () => {
  assert.throws(() => loadTable({ name: "A", csv: "agencias.csv", searchable_columns: ["provincia"] }, dir), /Columnas: Ciudad/);
});

test("crea la tabla e importa el CSV", async () => {
  const c = client({
    "GET /api/data-tables": () => [],
    "POST /api/data-tables": () => ({ dtb_code: "tb-1", dtb_name: "Agencias" }),
    "POST /api/data-tables/tb-1/rows": () => ({ inserted: 2 }),
  });
  const codes = await applyDataTables([{ name: "Agencias", csv: "agencias.csv", searchable_columns: ["ciudad"] }], ctx(c.api));
  assert.deepEqual(codes, ["tb-1"]);
  const rows = c.calls.find((x) => x.path === "/api/data-tables/tb-1/rows");
  assert.equal(rows.body.mode, "replace");
  assert.equal(rows.body.rows.length, 2);
});

test("con code solo enlaza", async () => {
  const code = "11111111-2222-3333-4444-555555555555";
  const c = client({ "GET /api/data-tables": () => [{ dtb_code: code, dtb_name: "Tarifas" }] });
  assert.deepEqual(await applyDataTables([{ code }], ctx(c.api)), [code]);
  assert.equal(c.calls.filter((x) => x.method !== "GET").length, 0);
});

test("403 al crear: mensaje con lo que hay que hacer en el panel", async () => {
  const c = client({
    "GET /api/data-tables": () => [],
    "POST /api/data-tables": () => ({ status: 403, body: { success: false, error: "You do not have permission" } }),
  });
  await assert.rejects(applyDataTables([{ name: "Agencias", csv: "agencias.csv" }], ctx(c.api)), /DATA TABLES.*data_tables\[\]\.code/s);
});

test("validateDataTablesSpec exige csv o code", () => {
  const errs = validateDataTablesSpec([{ name: "X" }]);
  assert.ok(errs.some((e) => /falta csv/.test(e)));
});
