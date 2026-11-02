# Cómo usar este skill en cada plataforma

El skill es un documento de instrucciones (`SKILL.md` + archivos en `references/`). Lo que cambia
entre plataformas es cómo se carga en el contexto del modelo. Para crear o actualizar agentes de
verdad, el modelo usa la CLI `attractor` de este repositorio (instálala antes).

## Claude Code

Instálalo como plugin (este repositorio es un marketplace):

```
/plugin install attractor-cli --marketplace CristhianAlcivar/attractor-cli
```

O copia la carpeta `skills/ai-agent-builder` a `~/.claude/skills/ai-agent-builder` (todos tus
proyectos) o a `<tu-proyecto>/.claude/skills/ai-agent-builder`.

Claude lo activa cuando el pedido coincide con la `description` del frontmatter
("créame un agente…", "cámbiale las instrucciones al agente…").

## Claude en la web o en la app de escritorio

Sube `dist/ai-agent-builder.zip` en **Customize → Skills → Upload a skill**. Ahí Claude no puede
llamar a la API de Attractor (salida de red restringida): te entrega la `spec.json` y tú corres
`attractor apply spec.json` en tu equipo.

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
