// Verificación de lo enlazado: después de aplicar, se relee el agente (servicio → configuración
// → prompt) y se confirma que cada acción de datos, tabla, KB e integración de la spec quedó
// enlazada. Enlazar una acción puede fallar (500) sin que se note, y entonces el agente
// "ejecuta" una herramienta que no tiene e inventa el resultado.

import { readAgent } from "./api.mjs";

/**
 * @param {Function} api
 * @param {string} serviceCode
 * @param {object} want
 *   tools:        [{ name, code }]          acciones de la spec (code puede faltar)
 *   tables:       [{ label, code }]
 *   kbs:          [code]
 *   integrations: patch de integraciones de la spec (resolveIntegrations().patch)
 * @returns {{ missing: string[], linked: string[] }}
 */
export async function verifyLinks(api, serviceCode, want = {}) {
  const { service, prompt } = await readAgent(api, serviceCode);
  const missing = [];
  const linked = [];
  if (!prompt) return { missing: ["el prompt del agente (la configuración no tiene prompt)"], linked };

  const actions = (prompt.dataactions || []).map((d) => (typeof d === "string" ? { code: d } : d));
  for (const t of want.tools || []) {
    const ok = actions.some((d) => (t.code && d.code === t.code) || (d.name && d.name === t.name));
    (ok ? linked : missing).push(`acción de datos "${t.name}"`);
  }

  const tableCodes = (prompt.answers?.data_tables || []).map((x) => x?.code ?? x);
  for (const t of want.tables || []) {
    (tableCodes.includes(t.code) ? linked : missing).push(`tabla de datos "${t.label}"`);
  }

  const kbCodes = (service.kbs || []).map((k) => k?.code ?? k);
  for (const code of want.kbs || []) {
    (kbCodes.includes(code) ? linked : missing).push(`base de conocimiento ${code}`);
  }

  const intg = service.integrations || {};
  if (want.integrations?.google_maps) {
    (intg.google_maps?.api_key ? linked : missing).push("integración Google Maps (key)");
  }
  if (want.integrations?.scrape) {
    const have = new Set((intg.scrape?.allow_hosts || []).map((h) => String(h).toLowerCase()));
    const lost = want.integrations.scrape.allow_hosts.filter((h) => !have.has(h));
    if (lost.length) missing.push(`integración Web scraping (${lost.join(", ")})`);
    else linked.push("integración Web scraping");
  }

  return { missing, linked };
}
