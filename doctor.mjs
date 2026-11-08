#!/usr/bin/env node
// Revisa una spec contra la plataforma sin cambiar nada (ver lib/doctor.mjs).
//
//   node doctor.mjs <spec.json> [--profile <nombre>]
//
// Credenciales: las mismas que apply (entorno → .env junto a la spec → perfil).
// Código de salida: 0 sin problemas (puede haber avisos) · 1 hay algo que corregir.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { applyProfileToEnv, normalizeBaseUrl } from "./profiles.mjs";
import { parseArgs } from "./lib/args.mjs";
import { createClient } from "./lib/api.mjs";
import { formatChecks, runDoctor } from "./lib/doctor.mjs";

const { flags, positional } = parseArgs(process.argv.slice(2), ["profile"]);
const [specPath] = positional;
if (!specPath) {
  console.error("Uso: attractor doctor <spec.json> [--profile <nombre>]");
  process.exit(1);
}

try {
  const specDir = dirname(resolve(specPath));
  loadDotEnv(resolve(specDir, ".env"));
  const used = applyProfileToEnv(typeof flags.profile === "string" ? flags.profile : undefined);
  const spec = JSON.parse(readFileSync(specPath, "utf8"));

  const base = normalizeBaseUrl(process.env.ATTRACTOR_BASE_URL || "");
  const clientId = process.env.ATTRACTOR_CLIENT_ID;
  const clientSecret = process.env.ATTRACTOR_CLIENT_SECRET;
  if (!base || !clientId || !clientSecret) {
    console.error("✗ No hay credenciales. Conéctate con: attractor login");
    process.exit(1);
  }

  console.log(`attractor doctor · ${spec.name ?? "(sin nombre)"} · ${base}${used ? ` · perfil ${used}` : ""}\n`);
  const client = createClient({ base, clientId, clientSecret });
  const checks = await runDoctor({ spec, client, wantedWorkspace: process.env.ATTRACTOR_WORKSPACE || "" });
  console.log(formatChecks(checks));
  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
} catch (err) {
  console.error(`✗ ${err.message}`);
  process.exit(1);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
