import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoiceRunner, voiceIssues, wavDurationSeconds, wordOverlap } from "../lib/voice.mjs";
import { runSuite } from "../lib/testing.mjs";
import { mockFetch } from "./mock-fetch.mjs";

// WAV PCM 16 kHz mono 16 bits con `seconds` de silencio.
function wav(seconds) {
  const rate = 16000;
  const data = Buffer.alloc(Math.round(rate * 2 * seconds));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test("wavDurationSeconds lee la duración del chunk data", () => {
  assert.equal(wavDurationSeconds(wav(2.5)), 2.5);
  assert.equal(wavDurationSeconds(Buffer.from("no es wav")), null);
});

test("voiceIssues marca lo que un TTS lee mal", () => {
  assert.deepEqual(voiceIssues("Abrimos de 9 a 18. ¿Te ayudo con algo más?"), []);
  const issues = voiceIssues("**Horario**:\n- Lunes 9:00\nVisita https://x.com 😀");
  assert.ok(issues.some((i) => /markdown/.test(i)));
  assert.ok(issues.some((i) => /lista/.test(i)));
  assert.ok(issues.some((i) => /URL/.test(i)));
  assert.ok(issues.some((i) => /emojis/.test(i)));
});

test("wordOverlap compara lo dicho con lo oído", () => {
  assert.equal(wordOverlap("¿A qué hora abren el sábado?", "a que hora abren el sabado"), 1);
  assert.ok(wordOverlap("quiero mi pedido P12345", "quieres un pedido") < 0.6);
});

test("prueba por voz: Piper dice el mensaje, el STT lo transcribe y la respuesta se mide", async () => {
  const saved = {};
  const { fetch, calls } = mockFetch({
    "POST /tts": (req) => ({ status: 200, body: "", rawBytes: wav(req.rawBody.get("text").length > 40 ? 12 : 2) }),
    "POST /stt": () => ({ status: 200, body: { text: "a que hora abren el sabado" } }),
  });
  const voice = createVoiceRunner({
    piperUrl: "http://piper.test", sttUrl: "http://stt.test", voice: "daniela", outDir: null, fetch,
    write: (p, b) => { saved[p] = b; },
  });
  const sent = [];
  const r = await runSuite({
    tests: [
      { message: "¿A qué hora abren el sábado?", expect: { contains: ["9"], max_seconds: 8 } },
      { message: "¿Y el domingo?", expect: { max_seconds: 8 } },
    ],
    voice,
    trigger: async (message) => {
      sent.push(message);
      return sent.length === 1
        ? { reply: "Abrimos a las 9 de la mañana.", startedAt: "t" }
        : { reply: "El **domingo** no abrimos, pero puedes escribirnos por la web cuando quieras.", startedAt: "t" };
    },
    newUserId: () => "u",
  });
  assert.equal(sent[0], "a que hora abren el sabado", "el agente recibe lo que se oyó");
  assert.equal(r.failed, 1, "el segundo caso falla: markdown y dura 12 s");
  const second = r.results[1][0].errors.join(" | ");
  assert.match(second, /markdown/);
  assert.match(second, /dura 12\.0 s \(máximo 8 s\)/);
  const tts = calls.filter((c) => c.path === "/tts");
  assert.equal(tts[0].rawBody.get("voice"), "daniela");
});

test("sin STT, el agente recibe el texto original", async () => {
  const { fetch } = mockFetch({ "POST /tts": () => ({ status: 200, body: "", rawBytes: wav(1) }) });
  const voice = createVoiceRunner({ piperUrl: "http://piper.test", outDir: null, fetch });
  const out = await voice.input("Hola", { run: 1, index: 0 });
  assert.deepEqual(out, { text: "Hola", warnings: [] });
});

test("preflight explica cómo levantar Piper si no responde", async () => {
  const fetch = async () => { throw new Error("ECONNREFUSED"); };
  const voice = createVoiceRunner({ piperUrl: "http://localhost:8100", outDir: null, fetch });
  await assert.rejects(voice.preflight(), /docker compose up -d.*PIPER_URL/);
});
