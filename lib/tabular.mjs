// Lee tablas desde CSV, TSV o Excel (.xlsx) sin dependencias, para cargarlas como
// «Tablas de datos» de Attractor. Devuelve { headers: string[], rows: string[][] }.
//
//   readTableFile("sucursales.xlsx", { sheet: "Hoja1" })
//
// El .xlsx es un zip con XML adentro: se lee el directorio central del zip, se descomprime
// con zlib (deflate) y se recorren sharedStrings, la hoja y los estilos (para reconocer fechas).

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";

export function readTableFile(path, { sheet } = {}) {
  const ext = extname(path).toLowerCase();
  if (ext === ".xlsx") return trimTable(readXlsx(readFileSync(path), sheet));
  if (ext === ".csv" || ext === ".tsv" || ext === ".txt") {
    let text = readFileSync(path, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return trimTable(parseCsv(text, ext === ".tsv" ? "\t" : undefined));
  }
  throw new Error(`tipo de tabla no soportado: ${path} (usa .csv, .tsv o .xlsx)`);
}

// Primera fila = encabezados. Quita filas y columnas vacías al final.
function trimTable(matrix) {
  const rows = matrix.filter((r) => r.some((c) => String(c ?? "").trim() !== ""));
  if (!rows.length) return { headers: [], rows: [] };
  const width = Math.max(...rows.map((r) => r.length));
  let last = width - 1;
  while (last >= 0 && rows.every((r) => String(r[last] ?? "").trim() === "")) last--;
  const norm = rows.map((r) => Array.from({ length: last + 1 }, (_, i) => String(r[i] ?? "").trim()));
  return { headers: norm[0], rows: norm.slice(1) };
}

// ---------------------------------------------------------------- CSV

export function parseCsv(text, delimiter) {
  const sep = delimiter || sniffDelimiter(text);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// Excel en español exporta con «;». Se elige el separador más frecuente en la primera línea.
function sniffDelimiter(text) {
  const first = text.split(/\r?\n/, 1)[0] || "";
  const counts = [",", ";", "\t", "|"].map((d) => [d, first.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

// ---------------------------------------------------------------- XLSX

function unzip(buf) {
  // Fin del directorio central: firma 0x06054b50, buscada desde el final.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("el .xlsx no es un zip válido");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("directorio del .xlsx dañado");
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    files.set(name, { method, size, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const f = files.get(name);
    if (!f) return null;
    const start = f.local + 30 + buf.readUInt16LE(f.local + 26) + buf.readUInt16LE(f.local + 28);
    const raw = buf.subarray(start, start + f.size);
    if (f.method === 0) return raw.toString("utf8");
    if (f.method === 8) return inflateRawSync(raw).toString("utf8");
    throw new Error(`compresión ${f.method} no soportada en el .xlsx`);
  };
}

function xmlText(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return m ? m[1] : null;
}

// Texto de cada <si>: concatena los <t> (las celdas con formato mixto vienen en varios tramos).
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join(""));
}

// Índices de estilo (cellXfs) cuyo formato de número es una fecha.
function dateStyles(xml) {
  const out = new Set();
  if (!xml) return out;
  const custom = new Map();
  for (const m of xml.matchAll(/<numFmt\s[^>]*>/g)) {
    custom.set(Number(attr(m[0], "numFmtId")), xmlText(attr(m[0], "formatCode") || ""));
  }
  const builtinDate = (id) => (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
  const cellXfs = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  if (!cellXfs) return out;
  [...cellXfs[1].matchAll(/<xf\s[^>]*?\/?>/g)].forEach((m, i) => {
    const id = Number(attr(m[0], "numFmtId") || 0);
    const code = custom.get(id);
    const isDate = builtinDate(id) || (code && /[dmy]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, "")) && !/^[#0.,%\s]+$/.test(code));
    if (isDate) out.add(i);
  });
  return out;
}

function colIndex(ref) {
  const letters = ref.replace(/\d+/g, "");
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function serialToDate(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const ms = Math.round((n - 25569) * 86400000); // 25569 = 1970-01-01 en el calendario de Excel
  const d = new Date(ms);
  const iso = d.toISOString();
  return d.getUTCHours() || d.getUTCMinutes() ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
}

function readXlsx(buf, sheetName) {
  const get = unzip(buf);
  const workbook = get("xl/workbook.xml");
  if (!workbook) throw new Error("el archivo no parece un Excel (.xlsx)");
  const sheets = [...workbook.matchAll(/<sheet\s[^>]*\/?>/g)].map((m) => ({
    name: xmlText(attr(m[0], "name") || ""),
    rid: attr(m[0], "r:id"),
  }));
  if (!sheets.length) throw new Error("el Excel no tiene hojas");
  const chosen = sheetName
    ? sheets.find((s) => s.name.trim().toLowerCase() === String(sheetName).trim().toLowerCase())
    : sheets[0];
  if (!chosen) throw new Error(`no existe la hoja "${sheetName}". Hojas: ${sheets.map((s) => s.name).join(", ")}`);

  const rels = get("xl/_rels/workbook.xml.rels") || "";
  const rel = [...rels.matchAll(/<Relationship\s[^>]*\/?>/g)].find((m) => attr(m[0], "Id") === chosen.rid);
  let target = rel ? attr(rel[0], "Target") : "worksheets/sheet1.xml";
  target = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const xml = get(target);
  if (!xml) throw new Error(`no se encontró la hoja "${chosen.name}" dentro del Excel`);

  const strings = sharedStrings(get("xl/sharedStrings.xml"));
  const dates = dateStyles(get("xl/styles.xml"));
  const matrix = [];
  for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
    const rowNum = Number(attr(r[0].match(/<row\b[^>]*>/)[0], "r")) || matrix.length + 1;
    const row = [];
    for (const c of (r[1] || "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const head = `<c${c[1]}>`;
      const ref = attr(head, "r");
      const type = attr(head, "t");
      const style = Number(attr(head, "s") || 0);
      const inner = c[2] || "";
      const v = inner.match(/<v>([\s\S]*?)<\/v>/);
      let value = "";
      if (type === "s") value = strings[Number(v?.[1])] ?? "";
      else if (type === "inlineStr") value = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => xmlText(t[1])).join("");
      else if (type === "b") value = v?.[1] === "1" ? "true" : "false";
      else if (v) value = dates.has(style) && type !== "str" ? serialToDate(v[1]) : xmlText(v[1]);
      row[ref ? colIndex(ref) : row.length] = value;
    }
    matrix[rowNum - 1] = row;
  }
  return Array.from(matrix, (r) => r || []);
}
