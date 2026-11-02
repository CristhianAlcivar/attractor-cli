# Cómo usar este skill en cada plataforma

El skill es un documento de instrucciones (`SKILL.md` + archivos en `references/`). Lo que cambia
entre plataformas es cómo se carga en el contexto del modelo. Para crear o actualizar agentes de
verdad, el modelo usa la CLI `attractor` de este repositorio (instálala antes).

## Claude Code

Copia la carpeta `skill/ai-agent-builder` a una de estas rutas:

- `~/.claude/skills/ai-agent-builder`: disponible en todos tus proyectos.
- `<tu-proyecto>/.claude/skills/ai-agent-builder`: solo en ese proyecto.

Claude lo activa cuando el pedido coincide con la `description` del frontmatter
("créame un agente…", "cámbiale las instrucciones al agente…").

## Kiro

Mismo formato. Copia la carpeta a `~/.kiro/skills/` o a `.kiro/skills/` del workspace.

## ChatGPT u otros asistentes sin skills

1. **Instrucciones del sistema:** pega el contenido de `SKILL.md` (sin el frontmatter) como
   instrucciones de un GPT personalizado o al inicio de la conversación, y agrega las
   referencias que necesites.
2. **GPT con Knowledge:** sube `SKILL.md` y los archivos de `references/` como conocimiento del
   GPT y pídele en las instrucciones que siga la metodología del skill.

Sin acceso a una terminal, el asistente te entrega la `spec.json` y tú corres
`attractor apply spec.json`.
