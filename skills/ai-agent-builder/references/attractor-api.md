# Crear un agente en Attractor por la API

Contratos que usa la CLI (`apply-agent.mjs`). Todo pasa por la API pública (`/api/...`) con un
token OAuth2 de una **aplicación API**.
Respuesta siempre `{ success, data, error }`.

## Credenciales

1. En el panel: Administración → Usuarios y permisos → **Aplicaciones API** → crear una con un rol
   que tenga: SERVICE, PROMPT, CONFIGURATION y DATA ACTION (acciones de datos) (leer, crear, editar), KNOWLEDGE
   (leer, crear), PROVIDER, MODEL y WORKSPACES (leer). El rol no puede ser `master`. El secret
   se muestra una sola vez; va en el `.env` junto al spec, nunca en el spec.
   Con la CLI, `attractor login` guarda la credencial en un perfil (ver el README del repositorio);
   el script la toma de ahí si no hay variables `ATTRACTOR_*` ni `.env`.
2. `POST /api/oauth/token` con Basic `client_id:client_secret` y `grant_type=client_credentials`
   → `access_token` (1 h por defecto, sin refresh: se pide otro).
3. Todas las llamadas llevan `Authorization: Bearer …` y `X-Workspace-Code: <uuid>`
   (obligatorio en `/api/service`; en prompt y KB define el workspace).

El panel no muestra el código del workspace. El script lo resuelve con
`GET /api/workspaces?org_code=<organization del token>` → `data.workspaces[] {code, name,
is_default}`: toma el de `ATTRACTOR_WORKSPACE` (nombre o código) o, si no se define, el
workspace por defecto. La organización sale del claim `organization` del access token.

Tope: 120 peticiones/min por aplicación (429 con `Retry-After`).

## Orden

Un agente son tres objetos: **prompt → configuración → servicio**. Las acciones de datos y la
KB se crean antes; las acciones se enlazan en el prompt y la KB en el servicio.

| # | Paso | Llamada | Cuerpo mínimo | Id devuelto |
|---|---|---|---|---|
| 0 | Modelo | `GET /api/provider`, `GET /api/model/provider/:code` | — | `code` del modelo |
| 1 | Acción de datos | `POST /api/data-action` | `{ name, url, method, input_contract:[{name,type,required,description}], timeout, permission }` | `data.code` |
| 2 | KB | `POST /api/knowledge` | `{ name, description?, status: 1 }` | `data.code` |
| 3a | Archivo | `POST /api/knowledge/document/ingest` (multipart) | `file`, `kb_code`, `source?` | `data.document.kd_code` |
| 3b | Texto | `POST /api/knowledge/document` | `{ knowledge_base, kind: "file", source, content }` | `data.code` |
| 3c | Artículo | `POST /api/knowledge/document` + `POST /api/knowledge/chunk/bulk` | `{ knowledge_base, kind: "article", source }` y `[{ kc_document, kc_text }]` | `data.code` |
| 4 | Prompt | `POST /api/prompt` | `name, role:"system", type:"chat", max_tokens, status:1, template:"agent", dataactions:[...], answers{ objective, instructions, tool_guidance, … }` | `data.code` |
| 5 | Configuración | `POST /api/configuration` | `{ name, model, category:"chat", temperature, prompts:[prompt] }` | `data.code` |
| 6 | Agente | `POST /api/service` | `{ name, configuration, kbs:[kb], channel?, integrations? }` | `data.service.code` |
| 7 | Publicar | `POST /api/service/:code/publish` | `{}` | `data.version` |
| 8 | Probar | `POST /api/agents/:code/trigger` (sin JWT, `X-Trigger-Token`) | `{ message, user_id? }` | `data.reply.text` |

## Actualizar un agente existente

`apply-agent.mjs` busca el agente por nombre en el workspace. Si existe, lee lo guardado y solo
escribe lo que difiere de la spec:

| Objeto | Leer | Escribir | Notas |
|---|---|---|---|
| Acción de datos | `GET /api/data-action?search=<name>` → `data.dataactions[]` | `PUT /api/data-action/:code` | Cuerpo completo; se reenvía `prompts` para no perder enlaces. |
| Prompt | `GET /api/prompt/:code` | `PUT /api/prompt/:code` | Parcial. `answers` reemplaza el objeto entero: se envía lo guardado + lo que cambia (siempre con `objective`). `tool_guidance` y `tools_policies` se conservan si no se envían. |
| Configuración | `GET /api/configuration/:code` (`model.code`, `prompts[].code`) | `PUT /api/configuration/:code` | `{ name, model, temperature, timezone, prompts, status }`. |
| Agente | `GET /api/service/:code` (`configuration.code`, `kbs[]`, `channels[]`, `integrations`, `publishedVersion`) | `PUT /api/service/:code` | Exige `name` y `configuration`. `kbs` reemplaza el conjunto; `integrations` sin enviar no se toca; `channel` nulo no quita despliegues. |

Lo que la spec no declara no se toca: sin `tools` no cambia las herramientas del prompt, sin
`knowledge_base` no cambia las KB del agente. Si los declara, la spec manda (reemplaza el
conjunto). Solo se publica si algo cambió o el agente nunca se publicó.

## Cómo responde el agente con la KB

- **Archivos y textos (`kind: "file"`)**: se guardan como texto completo y el agente los recibe
  **dentro de su contexto** (CAG). Sin embeddings ni espera. Tope total ~60.000 caracteres
  Tipos: pdf, docx, txt, md, html; máx. 25 MB.
- **Artículos (`kind: "article"`)**: se parten en fragmentos con embeddings (se calculan en la
  misma petición con la llave de OpenAI de la plataforma) y el agente los busca con la tool
  `search_knowledge`. Para contenido que no cabe en el tope de CAG.
- No hay ingesta por URL: descarga el contenido y súbelo como archivo o texto.

## A tener en cuenta

- **El prompt se envía siempre con `answers`** y un `objective` no vacío.
- **Nombre de configuración**: único en toda la plataforma (no por organización). El script le
  agrega un sufijo aleatorio.
- **Nombres como llave**: el agente se busca por nombre en el workspace, las acciones de datos
  por nombre en la organización/workspace y la KB por nombre en la organización. Renombrar en el
  panel hace que el script cree uno nuevo.
- **KB existente**: el script la reutiliza pero no vuelve a subir documentos (no hay forma de
  saber cuáles ya están sin duplicarlos). Cambia el contenido desde el panel.
- **`PUT /api/service/:code` exige el cuerpo completo** (`name`, `configuration`, `kbs`…): lee el
  servicio y reenvía todo con el cambio.
- **Descripción de herramientas**: la acción de datos no tiene campo de descripción; el texto de
  «cuándo usarla» va en `answers.tool_guidance[<nombre>]` del prompt.
- **Publicar antes de probar**: el disparador HTTP y los canales de producción usan la versión
  publicada.
- **Las pruebas van por el disparador HTTP** del agente (`integrations.http_trigger = { enabled, token ≥16, response_mode: "sync" }`).
  Encenderlo o apagarlo no requiere publicar. El script lo enciende para probar y lo apaga al terminar, salvo
  `http_trigger.keep: true` o que ya estuviera encendido.
- **Canal**: con `channel` (uuid de `GET /api/channel`) el script despliega el agente en ese
  canal; sin él no lo despliega en ninguno.
