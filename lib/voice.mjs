// Pruebas de voz con Piper.
//
// Por cada caso:
//   1. Piper sintetiza el mensaje del cliente → WAV (lo que "dice" la persona).
//   2. Si hay STT (ATTRACTOR_STT_URL → POST /stt de speech-service), se transcribe ese audio y el
//      agente recibe lo que se oyó, como en una llamada. Sin STT, recibe el texto original.
//   3. La respuesta se revisa como texto para voz: sin markdown, enlaces, emojis ni tablas,
//      que un TTS lee mal o en voz alta.
//   4. Piper sintetiza la respuesta → WAV, y se mide cuánto dura (expect.max_seconds).
//
// Los WAV quedan en la carpeta de la spec (voz-pruebas/ por defecto) para escucharlos.
//
// Piper: piper-service del monorepo (POST /tts multipart: text, voice, speed). Local:
//   cd piper-service && docker compose up -d   → http://localhost:8100

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PIPER_URL = "http://localhost:8100";

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export async function piperSynthesize({ url, text, voice, speed, fetch: f = globalThis.fetch }) {
  const form = new FormData();
  form.append("text", text);
  if (voice) form.append("voice", voice);
  if (speed !== undefined) form.append("speed", String(speed));
  const res = await f(`${url}/tts`, { method: "POST", body: form });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Piper respondió ${res.status} en ${url}/tts${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Duración de un WAV PCM leyendo los chunks fmt y data. null si no es un WAV. */
export function wavDurationSeconds(buf) {
  if (!buf || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") return null;
  let byteRate = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = buf.readUInt32LE(off + 16);
    if (id === "data") {
      // Piper en streaming puede dejar el tamaño en 0 o en 0xFFFFFFFF: se usa lo que hay.
      const real = size === 0 || size === 0xffffffff || off + 8 + size > buf.length ? buf.length - off - 8 : size;
      return byteRate ? real / byteRate : null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** Transcribe con POST /stt de speech-service (cuerpo = audio crudo). */
export async function transcribe({ url, audio, language = "es-ES", fetch: f = globalThis.fetch }) {
  const res = await f(`${url}/stt?format=wav&language=${encodeURIComponent(language)}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: audio,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`STT respondió ${res.status}: ${body.error ?? ""}`);
  const text = body.text ?? body.transcript ?? body.data?.text;
  if (typeof text !== "string") throw new Error("STT no devolvió texto");
  return text.trim();
}

/** Lo que un TTS lee mal: markdown, enlaces, emojis, tablas. */
export function voiceIssues(text) {
  const t = String(text ?? "");
  const issues = [];
  if (/\*\*[^*]+\*\*|__[^_]+__|`[^`]+`/.test(t)) issues.push("tiene formato markdown (negritas o código)");
  if (/^\s{0,3}#{1,6}\s/m.test(t)) issues.push("tiene títulos markdown (#)");
  if (/^\s*([-*•]|\d+[.)])\s+\S/m.test(t)) issues.push("tiene una lista con viñetas o numerada");
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) issues.push("tiene un enlace markdown");
  else if (/https?:\/\/|www\./i.test(t)) issues.push("lee una URL en voz alta");
  if (/\p{Extended_Pictographic}/u.test(t)) issues.push("tiene emojis");
  if (/^\s*\|.*\|\s*$/m.test(t)) issues.push("tiene una tabla");
  return issues;
}

/** Parecido entre lo dicho y lo oído (0–1), por palabras. */
export function wordOverlap(a, b) {
  const words = (s) => fold(s).replace(/[^a-z0-9ñ\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const wa = words(a);
  if (!wa.length) return 1;
  const wb = new Set(words(b));
  return wa.filter((w) => wb.has(w)).length / wa.length;
}

/**
 * Prepara las pruebas de voz para runSuite({ voice }).
 * @param {object} o  { piperUrl, voice, speed, sttUrl, language, outDir, strict, fetch }
 */
export function createVoiceRunner({
  piperUrl = DEFAULT_PIPER_URL, voice, speed, sttUrl, language = "es-ES", outDir, strict = true,
  fetch: f = globalThis.fetch, write = writeFileSync,
}) {
  const url = piperUrl.replace(/\/+$/, "");
  const stt = sttUrl ? sttUrl.replace(/\/+$/, "") : null;
  if (outDir) mkdirSync(outDir, { recursive: true });
  const fileName = (ctx, who) => `r${ctx.run}-${String(ctx.index + 1).padStart(2, "0")}-${who}.wav`;
  const save = (name, buf) => { if (outDir) write(join(outDir, name), buf); };

  return {
    describe: () => `Piper ${url}${voice ? ` (voz ${voice})` : ""}; ${stt ? `STT ${stt}` : "sin STT: el agente recibe el texto original"}`,

    async preflight() {
      try {
        const res = await f(`${url}/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err) {
        throw new Error(`No responde Piper en ${url} (${err.message}). Levántalo con «cd piper-service && docker compose up -d» o define PIPER_URL.`);
      }
    },

    // Lo que oye el agente. → { text, warnings }
    async input(message, ctx) {
      const audio = await piperSynthesize({ url, text: message, voice, speed, fetch: f });
      save(fileName(ctx, "cliente"), audio);
      if (!stt) return { text: message, warnings: [] };
      const heard = await transcribe({ url: stt, audio, language, fetch: f });
      const warnings = wordOverlap(message, heard) < 0.6 ? ["el STT entendió algo distinto a lo que se dijo"] : [];
      return { text: heard || message, warnings };
    },

    // La respuesta, como voz. → { errors, warnings, notes }
    async check(reply, test, ctx) {
      const errors = [];
      const warnings = [];
      const notes = [];
      const issues = voiceIssues(reply);
      (strict ? errors : warnings).push(...issues.map((i) => `para voz: ${i}`));
      try {
        const audio = await piperSynthesize({ url, text: reply, voice, speed, fetch: f });
        save(fileName(ctx, "agente"), audio);
        const secs = wavDurationSeconds(audio);
        if (secs != null) {
          notes.push(`Voz: ${secs.toFixed(1)} s${outDir ? ` · ${fileName(ctx, "agente")}` : ""}`);
          const max = test.expect?.max_seconds;
          if (max && secs > max) errors.push(`dicho en voz dura ${secs.toFixed(1)} s (máximo ${max} s)`);
        }
      } catch (err) {
        errors.push(`Piper no pudo sintetizar la respuesta: ${err.message}`);
      }
      return { errors, warnings, notes };
    },
  };
}
