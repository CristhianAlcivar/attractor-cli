# attractor-cli

Crea y mantiene agentes de [Attractor Agents](https://attractoragents.com) desde un archivo
`spec.json`, desde la terminal.

- **La spec es la fuente de verdad.** Si el agente no existe, lo crea; si existe, compara y
  solo cambia lo distinto: herramientas, base de conocimiento, instrucciones y modelo.
- **Pruebas que verifican.** Cada spec trae casos con lo que se espera de la respuesta. Si uno
  falla, el comando termina con código 2, así que sirve en CI.
- **Perfiles como la CLI de Genesys.** Te conectas una vez con `attractor login` y eliges la
  empresa con `--profile`.
- **Incluye un plugin para Claude** (y el skill para Kiro o ChatGPT) que te ayuda a diseñar el
  agente y escribe la spec por ti. Ver **Usarlo con Claude**.

Sin dependencias. Requiere Node.js 18 o superior.

## Instalación

```bash
npm install -g github:CristhianAlcivar/attractor-cli
attractor help
```

O clonando el repositorio:

```bash
git clone https://github.com/CristhianAlcivar/attractor-cli.git
cd attractor-cli
npm install -g .
```

Para desinstalar: `npm uninstall -g attractor-cli`.

## 1. Crea una aplicación API en Attractor

En el panel: **Administración → Usuarios y permisos → Aplicaciones API → Crear**. Asígnale un
rol con estos permisos:

| Módulo | Permisos |
|---|---|
| SERVICE, PROMPT, CONFIGURATION, DATA ACTION | leer, crear, editar |
| KNOWLEDGE | leer, crear |
| PROVIDER, MODEL, WORKSPACES | leer |

Copia el **client ID** (`atr_…`) y el **client secret** (`atrs_…`). El secret se muestra una
sola vez.

## 2. Conéctate

```bash
attractor login
```

Te pide la URL de la plataforma (por defecto `https://attractoragents.com`; basta el dominio), el
client ID y el secret. El secret no se muestra mientras lo escribes. El comando valida la
credencial y guarda un perfil. Si la organización tiene varios workspaces, puedes fijar uno; con
Enter se usa el workspace por defecto.

| Comando | Qué hace |
|---|---|
| `attractor login [--profile <nombre>]` | Crea o reemplaza un perfil |
| `attractor profiles` | Lista los perfiles (`*` = por defecto). Nunca muestra el secret |
| `attractor use <perfil>` | Cambia el perfil por defecto |
| `attractor whoami [--profile p]` | Comprueba que la credencial funciona |
| `attractor logout [<perfil>]` | Borra el perfil de este equipo |

## 3. Escribe la spec

```bash
attractor init mi-agente
```

Crea `mi-agente/spec.json` con un ejemplo completo y el schema (`agent-spec.schema.json`), para
que tu editor autocomplete y valide los campos.

```json
{
  "$schema": "./agent-spec.schema.json",
  "name": "Stela",
  "objective": "Responder preguntas sobre productos, horarios y estado de pedidos.",
  "instructions": "Eres Stela... Si no sabes algo, dilo y ofrece un asesor.",
  "model": { "provider": "OpenAI", "name": "gpt-4.1-mini" },
  "knowledge_base": {
    "name": "KB Stela",
    "files": ["./preguntas-frecuentes.pdf"]
  },
  "tools": [
    {
      "name": "consultar_pedido",
      "description": "Úsala cuando el cliente pregunte por el estado de su compra.",
      "method": "GET",
      "url": "https://api.tu-empresa.com/pedidos/{numero}",
      "input": [{ "name": "numero", "type": "string", "required": true }]
    }
  ],
  "tests": [
    { "message": "¿A qué hora abren el sábado?", "expect": { "contains_any": ["9:00"] } },
    { "message": "¿Cuánto cuesta el envío a Marte?", "expect": { "refuses": true } }
  ]
}
```

| Campo | Para qué |
|---|---|
| `name`, `objective` | Obligatorios. El nombre identifica al agente: volver a aplicar la spec lo actualiza |
| `instructions`, `tone`, `constraints`, `initial_message` | Comportamiento (system prompt) |
| `model`, `temperature` | `{provider, name}` o `{code}` |
| `knowledge_base` | KB nueva (`files`, `texts`, `articles`) o existente (`code`) |
| `tools` | Acciones de datos: llamadas HTTP que el agente puede hacer |
| `channel` | Canal donde desplegarlo (uuid). Sin él no se despliega |
| `tests` | Casos con `expect`: `contains`, `contains_any`, `not_contains`, `matches`, `refuses`, `max_chars` |

Todos los campos están descritos en [`agent-spec.schema.json`](agent-spec.schema.json).

**Base de conocimiento:**
- Los **archivos** (pdf, docx, txt, md, html) y los **textos** van completos al contexto del
  agente, hasta unos 60.000 caracteres en total.
- Los **artículos** se parten en fragmentos para buscar en contenido largo.
- Si la KB ya existe, no se le vuelven a subir documentos: cámbialos desde el panel.

## 4. Consulta tus agentes

```bash
attractor list                        # todos los agentes, agrupados por workspace
attractor list --workspace Ventas     # solo un workspace
attractor list --search stela --json  # filtrar y obtener JSON
```

Muestra el nombre, la versión publicada, el código y los canales de cada agente.

## 5. Aplica

```bash
attractor apply mi-agente/spec.json --dry-run   # qué crearía o cambiaría; no escribe nada
attractor apply mi-agente/spec.json             # aplica, publica si algo cambió y corre las pruebas
attractor apply mi-agente/spec.json --test-only # solo las pruebas, contra la versión publicada
attractor apply mi-agente/spec.json --profile acme
```

| Código de salida | Significado |
|---|---|
| `0` | Todo bien |
| `1` | Error (spec inválida, credenciales, API) |
| `2` | Alguna prueba falló |

Las pruebas usan el disparador HTTP del agente: la CLI lo enciende para probar y lo apaga al
terminar, salvo que pongas `"http_trigger": { "keep": true }`.

### De dónde salen las credenciales

1. Con `--profile <nombre>`, ese perfil.
2. Si no: las variables `ATTRACTOR_BASE_URL`, `ATTRACTOR_CLIENT_ID`, `ATTRACTOR_CLIENT_SECRET`
   y `ATTRACTOR_WORKSPACE` (opcional) del entorno.
3. Si no: un archivo `.env` junto a la spec, con esas mismas variables.
4. Si no: el perfil de `ATTRACTOR_PROFILE` o el perfil por defecto.

En CI, sin consola interactiva:

```bash
ATTRACTOR_CLIENT_SECRET=... attractor login --url https://attractoragents.com --client-id atr_... --profile ci
# o directamente las variables ATTRACTOR_* y: attractor apply spec.json
```

## Usarlo con Claude

El skill `ai-agent-builder` diseña el agente contigo (objetivo, instrucciones, herramientas, base
de conocimiento, guardrails y pruebas), escribe la `spec.json` y la aplica con esta CLI. Funciona
con tu suscripción de Claude: no necesitas una llave de API de Anthropic.

### Claude Code (recomendado)

Este repositorio es un plugin de Claude Code. Dentro de una sesión de Claude Code:

```
/plugin install attractor-cli --marketplace CristhianAlcivar/attractor-cli
```

En versiones anteriores a la 2.1.275, en dos pasos:

```
/plugin marketplace add CristhianAlcivar/attractor-cli
/plugin install attractor-cli@attractor
```

O desde la terminal: `claude plugin marketplace add CristhianAlcivar/attractor-cli` y
`claude plugin install attractor-cli@attractor --scope user`.

Luego pídele, por ejemplo: «créame un agente que se llame Stela y responda con estas preguntas
frecuentes». El skill también se puede llamar directamente con `/attractor-cli:ai-agent-builder`.
Instala también la CLI (sección **Instalación**) y conéctate con `attractor login` en tu
terminal: Claude la usa para crear el agente.

Para recibir versiones nuevas: `/plugin marketplace update attractor`.

### Claude en la web o en la app de escritorio

1. Descarga [`dist/ai-agent-builder.zip`](dist/ai-agent-builder.zip).
2. En Claude: **Customize → Skills → + → Create skill → Upload a skill** y sube el ZIP.
   Según el plan, el menú puede aparecer como **Settings → Capabilities**.
3. Actívalo y pídele que diseñe tu agente.

En la web, Claude no puede llamar a la API de Attractor porque su entorno solo permite salir a
ciertos dominios. Te entrega la `spec.json` y tú la aplicas en tu equipo con
`attractor apply spec.json`.

### Kiro, ChatGPT y otros

Ver [`platform-usage.md`](skills/ai-agent-builder/references/platform-usage.md).

## Qué no cubre todavía

Se configura en el panel:
- agentes de voz, salientes o con flujo guiado;
- tablas de datos;
- perfiles de autenticación de las acciones de datos. Créalos en el panel y referéncialos con
  `auth_profile`.

## Seguridad

- Los perfiles se guardan en `~/.attractor/config.json`, o en `$ATTRACTOR_CONFIG_DIR`. Igual
  que en otras CLI (`gc`, `aws`), el secret queda en texto plano dentro de tu carpeta de
  usuario. En Linux y macOS el archivo se crea con permisos 600.
- Usa una aplicación API por empresa, con un rol que solo tenga los permisos de la tabla de
  arriba.
- Si un equipo se comparte o se pierde, regenera el secret desde el panel. `attractor logout`
  solo borra la copia local.
- No pongas secretos en la spec ni la subas a un repositorio con un `.env`. El `.gitignore` de
  este repositorio ya excluye los `.env`.

## Licencia

[MIT](LICENSE)
