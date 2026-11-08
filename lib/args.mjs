// Argumentos de línea de comandos: `--flag valor`, `--flag=valor` y flags booleanos.
// `valueFlags` son los que llevan valor (su valor no cuenta como argumento posicional).

export function parseArgs(argv, valueFlags = []) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (eq >= 0) flags[name] = a.slice(eq + 1);
    else if (valueFlags.includes(name)) flags[name] = argv[++i];
    else flags[name] = true;
  }
  return { flags, positional };
}
