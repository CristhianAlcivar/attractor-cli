# Crear un agente en Attractor por la API

Contratos que usa la CLI (`apply-agent.mjs`). Todo pasa por la API pública (`/api/...`) con un
token OAuth2 de una **aplicación API**.
Respuesta siempre `{ success, data, error }`.

## Credenciales

1. En el panel: Configuración → Usuarios y permisos → **Aplicaciones API** → crear una con un rol
   que tenga: SERVICE, PROMPT, CONFIGURATION y DATA ACTION (acciones de datos) (leer, crear, editar), KNOWLEDGE
   (leer, crear), PROVIDER, MODEL y WORKSPACES (leer). Para `data_tables`, también DATA TABLES
   (leer, crear, editar); para verificar `called_tool`, TOOL LOGS (leer). El rol no puede ser
   `master`. El secret se muestra una sola vez; va en el `.env` junto al spec, nunca en el spec.
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
| 3d | Tabla de datos | `POST /api/data-tables` + `POST /api/data-tables/:code/rows` | `{ name, columns:[{key,label,type,is_key}], agent_access }` y `{ rows:[{…}], mode:"replace" }` | `data.dtb_code` |
| 6 | Agente | `POST /api/service` | `{ name, configuration, kbs:[kb], channel?, integrations? }` | `data.service.code` |
| 7 | Publicar | `POST /api/service/:code/publish` | `{}` | `data.version` |
| 8 | Probar | `POST /api/agents/:code/trigger` (sin JWT, `X-Trigger-Token`) | `{ message, user_id?, test: true }` | `data.reply.text` |

## Actualizar un agente existente

`apply-agent.mjs` busca el agente por nombre en el workspace. Si existe, lee lo guardado y solo
escribe lo que difiere de la spec:

| Objeto | Leer | Escribir | Notas |
|---|---|---|---|
| Acción de datos | `GET /api/data-action?search=<name>` → `data.dataactions[]` | `PUT /api/data-action/:code` | Cuerpo completo; se reenvía `prompts` para no perder enlaces. |
| Prompt | `GET /api/prompt/:code` | `PUT /api/prompt/:code` | Parcial. `answers` reemplaza el objeto entero: se envía lo guardado + lo que cambia (siempre con `objective`). `tool_guidance` y `tools_policies` se conservan si no se envían. |
| Configuración | `GET /api/configuration/:code` (`model.code`, `prompts[].code`) | `PUT /api/configuration/:code` | `{ name, model, temperature, timezone, prompts, status }`. |
| Agente | `GET /api/service/:code` → **`data.service`** (`configuration.code`, `kbs[]`, `channels[]`, `integrations`) | `PUT /api/service/:code` | Exige `name` y `configuration`. `kbs` reemplaza el conjunto; `integrations` sin enviar no se toca, enviada **reemplaza el objeto entero**; `channel` nulo no quita despliegues. |
| Tablas | `GET /api/data-tables` (toda la organización; se filtra por `dtb_workspace`), `GET /api/data-tables/:code/rows` | `PUT /api/data-tables/:code`, `POST …/rows` con `mode: "replace"` | Se enlazan en el prompt: `answers.data_tables = [códigos]`. |

Lo que la spec no declara no se toca: sin `tools` no cambia las herramientas del prompt, sin
`knowledge_base` no cambia las KB del agente, sin `data_tables` no cambia las tablas y sin
`integrations` no toca las integraciones. Si los declara, la spec manda (reemplaza el conjunto;
las integraciones se combinan, ver abajo). Solo se publica si algo cambió o el agente nunca se
publicó.

### Leer el agente: `{ service, serviceChannel }`

`GET /api/service/:code` **no devuelve el servicio directo**: responde
`{ data: { service, serviceChannel?, webConfig? } }`. Leerlo como si fuera el servicio deja
`configuration.code` y `name` en `undefined`: el script terminaba pidiendo
`/configuration/undefined` (500) y mandando `PUT /service` sin `name` (400). La CLI usa
`data.service` (`lib/api.mjs` → `readService`). El listado (`GET /api/service?search=`) sí trae
el servicio plano.

Además, el detalle trae `publishedVersion: null` aunque el agente esté publicado; el número real
viene en el listado y en `GET /api/service/:code/publish-status`
(`{ published_at, has_unpublished_changes }`).

### Escrituras que responden error y sí guardan

`PUT /api/prompt/:code` a veces responde 400 o 500 **y aun así guarda**, y la lectura
inmediata puede devolver el estado anterior (consistencia eventual). Por eso toda escritura de
prompt, configuración y agente se verifica: escribir → esperar ~2 s → releer → comparar lo
enviado (hasta 3 lecturas). Solo es un fallo si lo leído no coincide; el mensaje nombra los
campos que no quedaron (nunca valores). 401/403/404/409/413/422 se dan por fallidos sin releer.
La espera se cambia con `ATTRACTOR_VERIFY_DELAY_MS`.

### Integraciones: combinar, nunca reemplazar

`PUT /api/service/:code` con `integrations` **reemplaza el objeto completo**: mandar solo
`{ google_maps }` borra `http_trigger`, `smtp`, `scrape`… La CLI siempre parte de lo guardado,
combina cada integración un nivel adentro y conserva `http_trigger` si el cambio no lo trae.

| Integración en la spec | Se guarda como | Qué habilita |
|---|---|---|
| `google_maps { api_key_env, region?, language?, rate_limit_per_minute? }` | `integrations.google_maps { api_key, region, language, rate_limit_per_minute }` | Tools `geocode_location`, `search_nearby_places`, `find_nearest_place`, `calculate_route`, `get_place_details`, `generate_maps_link` (se activan al tener `api_key`) |
| `scrape { allow_hosts, timeout_ms? }` | `integrations.scrape { allow_hosts, timeout_ms }` | Web scraping, solo de esos dominios |

La key de Maps **no va en la spec**: `api_key_env` dice en qué variable de entorno (o del `.env`
junto a la spec) está. Se valida `^AIza[\w-]{30,}$` y nunca se imprime: los mensajes dicen
«key guardada (N car.)». `region` es ISO 3166-1 alfa-2 en minúsculas; `rate_limit_per_minute`,
de 1 a 6000. Ojo: `GET /api/service/:code` devuelve la key en claro; no lo vuelques en logs.

### Tablas de datos

- Con `code`, la tabla se enlaza tal cual. Sin `code`, se busca por nombre: si no existe se crea
  y se importa el archivo (`.csv`, `.tsv` o `.xlsx`, primera fila = encabezados, máx. 5000
  filas y 30 columnas); si existe, se actualizan columnas y filas cuando difieren.
- Cada encabezado se vuelve una clave `a-z0-9_` (`Teléfono` → `telefono`). El tipo se infiere;
  un número con ceros a la izquierda o un teléfono queda como texto.
- `searchable_columns` marca las columnas con `is_key` (por defecto, la primera).
- **La búsqueda del agente es por coincidencia EXACTA** en esas columnas: «Quito» no encuentra
  «quito » ni «Quito DM». Usa una columna normalizada (minúsculas, sin tildes ni espacios
  extra, p. ej. `ciudad`) como columna de búsqueda, di en `instructions` cómo escribir el valor
  («busca la ciudad en minúsculas») y deja que el modelo compare el resto de columnas al leer
  las filas.
- **403 en `/api/data-tables`**: el rol de la aplicación API no tiene el módulo DATA TABLES. Dale
  leer/crear/editar, o crea la tabla en el panel (Tablas de datos → Importar CSV) y ponla en la
  spec con `code`.

### Verificación de lo enlazado

Enlazar una acción de datos al prompt puede fallar (500) sin que se note: el agente queda sin la
herramienta, pero el prompt le dice que la tiene y termina inventando que la ejecutó. Después de
aplicar, la CLI relee servicio → configuración → prompt y confirma cada `tools[]`
(`dataactions`), `data_tables[]` (`answers.data_tables`), KB e integración. Si falta alguno lo
nombra y termina con código 2.

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
  Encenderlo o apagarlo no requiere publicar. El script lo enciende si está apagado, sin token o
  en modo `callback` (ahí la respuesta no vuelve en la llamada), y al terminar lo deja como
  estaba: apagado salvo `http_trigger.keep: true`, o en su modo anterior si ya estaba encendido.
- **Respuesta del disparador**: `data = { conversation_id, user_id, reply: { text, components,
  finish }, handoff, status: "answered" | "human_in_charge" | "error" }`. Con `status: "error"`
  el texto es genérico («Error interno.») y la prueba cuenta como fallida.
- **El disparador no devuelve trazas de herramientas.** Para `expect.called_tool` la CLI consulta
  `GET /api/tool-logs?serviceId=<agente>&startDate=<inicio del turno>` (`rows[].act_resource_id`
  = nombre de la herramienta). Ese endpoint exige el módulo TOOL LOGS en el rol; con 403 el caso
  queda «no verificable» (aviso, no falla). Los logs no se filtran por conversación: con tráfico
  real en el mismo agente, otra conversación podría dar un falso positivo.
- **Mismo `user_id` = misma conversación.** Los casos de una corrida comparten `user_id`;
  `new_conversation: true` cambia a uno nuevo desde ese caso, y cada corrida de `--runs` usa uno
  nuevo.
- **Canal**: con `channel` (uuid de `GET /api/channel`) el script despliega el agente en ese
  canal; sin él no lo despliega en ninguno.
- **Pruebas de voz** (`--voice` o `testing.voice`): no pasan por la API de Attractor. Piper
  (`piper-service`, `POST /tts` multipart `text`, `voice`, `speed` → WAV) dice el mensaje y la
  respuesta; con `ATTRACTOR_STT_URL` apuntando a `speech-service` (`POST /stt?format=wav&language=es-ES`,
  cuerpo = audio crudo → `{ text }`) el agente recibe la transcripción. `speech-service` no está
  expuesto en el gateway: hace falta un port-forward o una instancia local.
- **Borrar un agente de prueba**: `DELETE /api/service/:code`, `/api/prompt/:code` y
  `/api/data-action/:code`. `DELETE /api/configuration/:code` exige permiso de borrar
  CONFIGURATION; sin él la configuración queda huérfana y se borra en el panel.
