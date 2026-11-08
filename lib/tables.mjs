// Tablas de datos de Attractor (`/api/data-tables`) desde la spec:
//
//   "data_tables": [
//     { "name": "Agencias", "csv": "./agencias.csv", "searchable_columns": ["ciudad"] },
//     { "name": "Tarifas", "code": "<uuid de una tabla que ya existe>" }
//   ]
//
// Con `code` solo se enlaza la tabla al agente (answers.data_tables del prompt). Sin `code`, se
// busca por nombre: si no existe se crea y se importa el archivo; si existe se actualizan
// columnas y filas cuando difieren del archivo.
//
// La búsqueda del agente en una tabla es por coincidencia EXACTA en las columnas buscables
// (is_key): conviene filtrar por una columna normalizada (p. ej. `ciudad`) y dejar que el
// modelo compare el resto.

import { resolve } from "node:path";
import { readTableFile } from "./tabular.mjs";

// Límites de service-service (data-table.dto.ts).
export const TABLE_MAX_ROWS = 5000;
export const TABLE_MAX_COLUMNS = 30;
export const TABLE_MAX_CELL = 2000;
const ROWS_BATCH = 1000;

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

export const DATA_TABLES_403 =
  "La aplicación API no tiene permiso sobre las tablas de datos (403). En el panel: " +
  "Configuración → Usuarios y permisos → Roles → el rol de tu aplicación API → módulo DATA TABLES " +
  "(Tablas de datos) con leer, crear y editar. O crea la tabla en el panel (Tablas de datos → " +
  "Importar CSV) y pon su código en la spec como data_tables[].code.";

export function validateDataTablesSpec(list, { exists = () => true } = {}) {
  const errors = [];
  if (list === undefined) return errors;
  if (!Array.isArray(list)) return ["data_tables debe ser una lista"];
  const names = new Set();
  for (const [i, t] of list.entries()) {
    const at = `data_tables[${i}]${t?.name ? ` (${t.name})` : ""}`;
    if (!t || typeof t !== "object") { errors.push(`${at}: debe ser un objeto`); continue; }
    for (const k of Object.keys(t)) {
      if (!["name", "csv", "searchable_columns", "code", "description", "agent_access"].includes(k)) errors.push(`${at}: campo desconocido ${k}`);
    }
    if (t.code !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(t.code))) {
      errors.push(`${at}: code debe ser un uuid`);
    }
    if (!t.code) {
      if (!t.name || String(t.name).trim().length < 2) errors.push(`${at}: name es obligatorio`);
      if (names.has(fold(t.name))) errors.push(`${at}: nombre repetido`);
      names.add(fold(t.name));
      if (!t.csv) errors.push(`${at}: falta csv (archivo .csv, .tsv o .xlsx) o code de una tabla existente`);
      else if (!/\.(csv|tsv|txt|xlsx)$/i.test(t.csv)) errors.push(`${at}: tipo no soportado ${t.csv} (csv, tsv, xlsx)`);
      else if (!exists(t.csv)) errors.push(`${at}: no existe el archivo ${t.csv}`);
    }
    if (t.searchable_columns !== undefined && (!Array.isArray(t.searchable_columns) || !t.searchable_columns.length)) {
      errors.push(`${at}: searchable_columns es una lista de columnas (nombre del encabezado o clave)`);
    }
    if (t.agent_access !== undefined && !["read", "read_write"].includes(t.agent_access)) {
      errors.push(`${at}: agent_access es read o read_write`);
    }
  }
  return errors;
}

function columnKey(label, used) {
  const key = fold(label).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || `col_${used.size + 1}`;
  let out = key;
  for (let n = 2; used.has(out); n++) out = `${key.slice(0, 38 - String(n).length)}_${n}`;
  used.add(out);
  return out;
}

// number solo sin ceros a la izquierda ni signos de teléfono («00123» o «+593…» quedan texto).
function inferType(values) {
  const vals = values.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!vals.length) return "text";
  if (vals.every((v) => /^-?(0|[1-9]\d{0,14})([.,]\d+)?$/.test(v))) return "number";
  if (vals.every((v) => /^(true|false|s[ií]|no|yes)$/i.test(v))) return "boolean";
  if (vals.every((v) => /^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(v))) return "date";
  return "text";
}

/** Lee el archivo de la tabla y devuelve { columns, rows } listos para la API. */
export function loadTable(t, specDir) {
  const { headers, rows: matrix } = readTableFile(resolve(specDir, t.csv));
  if (!headers.length) throw new Error(`la tabla "${t.name}" no tiene encabezados`);
  if (headers.length > TABLE_MAX_COLUMNS) throw new Error(`la tabla "${t.name}" tiene ${headers.length} columnas (máximo ${TABLE_MAX_COLUMNS})`);
  if (matrix.length > TABLE_MAX_ROWS) throw new Error(`la tabla "${t.name}" tiene ${matrix.length} filas (máximo ${TABLE_MAX_ROWS})`);

  const used = new Set();
  const keys = headers.map((h) => columnKey(h, used));
  const wanted = (t.searchable_columns || []).map(fold);
  const unknown = wanted.filter((w) => !headers.some((h, i) => fold(h) === w || keys[i] === w));
  if (unknown.length) {
    throw new Error(`la tabla "${t.name}": searchable_columns no existe en el archivo: ${unknown.join(", ")}. Columnas: ${headers.join(", ")}`);
  }
  const columns = headers.map((h, i) => ({
    key: keys[i],
    label: String(h).slice(0, 80) || keys[i],
    type: inferType(matrix.map((r) => r[i])),
    is_key: wanted.length ? wanted.includes(fold(h)) || wanted.includes(keys[i]) : i === 0,
  }));
  const rows = matrix
    .map((r) => rowData(Object.fromEntries(columns.map((c, i) => [c.key, r[i]])), columns))
    .filter((r) => Object.keys(r).length);
  return { columns, rows };
}

// La misma normalización que hace service-service al guardar, para comparar sin falsos cambios.
export function rowData(raw, columns) {
  const out = {};
  for (const c of columns) {
    const v = raw[c.key];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    if (c.type === "number") {
      const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
      if (!Number.isNaN(n)) out[c.key] = n;
    } else if (c.type === "boolean") {
      out[c.key] = typeof v === "boolean" ? v : ["true", "1", "si", "sí", "yes", "x"].includes(String(v).trim().toLowerCase());
    } else {
      out[c.key] = String(v).trim().slice(0, TABLE_MAX_CELL);
    }
  }
  return out;
}

const rowKey = (r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]));
const sameColumns = (a, b) =>
  JSON.stringify((a || []).map((c) => [c.key, c.label, c.type, Boolean(c.is_key)])) ===
  JSON.stringify((b || []).map((c) => [c.key, c.label, c.type, Boolean(c.is_key)]));

const tableCode = (t) => t?.dtb_code ?? t?.code ?? null;
const tableName = (t) => t?.dtb_name ?? t?.name ?? "";

/** Un 403 de /data-tables se traduce en el mensaje de qué hacer en el panel. */
export async function tablesCall(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err.status === 403) {
      const e = new Error(DATA_TABLES_403);
      e.status = 403;
      throw e;
    }
    throw err;
  }
}

export async function listTables(api, workspace) {
  const data = await tablesCall(() => api("GET", "/data-tables"));
  const all = Array.isArray(data) ? data : data.items || data.data_tables || [];
  // El GET no filtra por workspace: llegan las de toda la organización.
  return all.filter((t) => !t.dtb_workspace || !workspace || t.dtb_workspace === workspace);
}

async function tableRows(api, code) {
  const rows = [];
  for (let page = 1; page <= 100; page++) {
    const data = await tablesCall(() => api("GET", `/data-tables/${code}/rows?page=${page}&limit=200`));
    const batch = data.rows || [];
    rows.push(...batch.map((r) => r.dtr_data || r.data || {}));
    if (!batch.length || rows.length >= (data.total ?? 0)) break;
  }
  return rows;
}

async function uploadRows(api, code, rows) {
  if (!rows.length) return tablesCall(() => api("DELETE", `/data-tables/${code}/rows`));
  for (let i = 0; i < rows.length; i += ROWS_BATCH) {
    await tablesCall(() => api("POST", `/data-tables/${code}/rows`, {
      json: { rows: rows.slice(i, i + ROWS_BATCH), mode: i === 0 ? "replace" : "append" },
    }));
  }
}

/**
 * Crea, actualiza o resuelve las tablas de la spec. Devuelve sus códigos (NEW en simulación).
 * ctx: { api, workspace, specDir, mutate, log, NEW, offline }
 */
export async function applyDataTables(list, ctx) {
  if (!list) return null; // la spec no maneja tablas: no se tocan
  const { api, workspace, specDir, mutate, log, NEW, offline } = ctx;
  let existing = [];
  let canList = !offline;
  if (canList) {
    try {
      existing = await listTables(api, workspace);
    } catch (err) {
      // Sin permiso de lectura, las tablas con code se pueden enlazar igual.
      if (err.status !== 403 || list.some((t) => !t.code)) throw err;
      canList = false;
      log("  · sin permiso para listar tablas de datos: enlazo las de code sin comprobar que existan");
    }
  }

  const codes = [];
  for (const t of list) {
    if (t.code) {
      const found = existing.find((x) => tableCode(x) === t.code);
      if (canList && !found) throw new Error(`No existe la tabla de datos ${t.code} en este workspace.`);
      log(`· Tabla de datos existente: ${found ? tableName(found) : t.code}`);
      codes.push(t.code);
      continue;
    }

    const { columns, rows } = loadTable(t, specDir);
    const access = t.agent_access || "read";
    const searchable = columns.filter((c) => c.is_key).map((c) => c.key).join(", ") || "ninguna";
    const summary = `${columns.length} columnas, ${rows.length} filas; busca por ${searchable}`;
    const current = existing.find((x) => fold(tableName(x)) === fold(t.name));

    if (!current) {
      const created = await mutate(`Tabla de datos "${t.name}": crear e importar ${t.csv} (${summary})`, async () => {
        const data = await tablesCall(() => api("POST", "/data-tables", {
          json: { name: t.name, description: t.description || "", columns, agent_access: access, workspace_code: workspace || undefined },
        }));
        const code = tableCode(data) || tableCode(data?.table);
        if (!code) throw new Error(`POST /api/data-tables no devolvió el código de "${t.name}"`);
        if (rows.length) await uploadRows(api, code, rows);
        return code;
      });
      codes.push(created);
      continue;
    }

    const code = tableCode(current);
    const diffs = [];
    const patch = {};
    if (!sameColumns(current.dtb_columns, columns)) { diffs.push("columnas"); patch.columns = columns; }
    if (t.description !== undefined && (current.dtb_description ?? "") !== t.description) { diffs.push("descripción"); patch.description = t.description; }
    if ((current.dtb_agent_access || "read") !== access) { diffs.push(`acceso del agente (${current.dtb_agent_access} → ${access})`); patch.agent_access = access; }
    if (diffs.length) {
      await mutate(`Tabla de datos "${t.name}": actualizar ${diffs.join(", ")}`, () =>
        tablesCall(() => api("PUT", `/data-tables/${code}`, { json: patch })));
    }
    const have = await tableRows(api, code);
    const a = have.map(rowKey).sort();
    const b = rows.map(rowKey).sort();
    if (patch.columns || JSON.stringify(a) !== JSON.stringify(b)) {
      await mutate(`Tabla de datos "${t.name}": reemplazar filas (${have.length} → ${rows.length})`, () => uploadRows(api, code, rows));
    } else if (!diffs.length) {
      log(`· Tabla de datos "${t.name}": sin cambios (${summary})`);
    }
    codes.push(code);
  }
  return codes.map((c) => c ?? NEW);
}
