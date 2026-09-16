/** Where each agent keeps its project-scoped MCP config, and how telex gets it there. */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
export function agents() {
    const std = (entry) => entry;
    return [
        { id: "claude", label: "Claude Code", file: ".mcp.json", path: ["mcpServers", "telex"], value: std,
            cli: (bot) => ["claude", "mcp", "add", "--scope", "project", "telex", ...(bot ? ["--env", `TELEX_BOT=${bot}`] : []), "--", "telex", "serve"] },
        { id: "gemini", label: "Gemini CLI", cli: (bot) => ["gemini", "mcp", "add", "--scope", "project", ...(bot ? ["-e", `TELEX_BOT=${bot}`] : []), "telex", "telex", "serve"] },
        { id: "qwen", label: "Qwen Code", cli: (bot) => ["qwen", "mcp", "add", "--scope", "project", ...(bot ? ["-e", `TELEX_BOT=${bot}`] : []), "telex", "telex", "serve"] },
        { id: "codex", label: "Codex CLI", file: ".codex/config.toml", localFile: ".codex/config.local.toml", toml: true },
        { id: "cursor", label: "Cursor", file: ".cursor/mcp.json", path: ["mcpServers", "telex"], value: std },
        { id: "roo", label: "Roo Code", file: ".roo/mcp.json", path: ["mcpServers", "telex"], value: std },
        { id: "vscode", label: "VS Code", file: ".vscode/mcp.json", path: ["servers", "telex"], value: (e) => ({ type: "stdio", ...e }) },
        { id: "zed", label: "Zed", file: ".zed/settings.json", path: ["context_servers", "telex"], value: (e) => ({ source: "custom", ...e }) },
        { id: "amp", label: "Amp", file: ".amp/settings.json", path: ["amp.mcpServers", "telex"], value: std },
        { id: "opencode", label: "opencode", file: "opencode.json", path: ["mcp", "telex"], value: (e) => ({ type: "local", command: [e.command, ...e.args], ...(e.env ? { environment: e.env } : {}) }) },
        { id: "crush", label: "Crush", file: ".crush.json", path: ["mcp", "telex"], value: (e) => ({ type: "stdio", ...e }) },
    ];
}
/** What the agent's file should contain, standalone — used for printing and for a fresh file. */
export function snippet(agent, entry) {
    if (agent.toml)
        return tomlBlock(entry);
    return JSON.stringify(nest(agent.path, agent.value(entry)), null, 2);
}
export function tomlBlock(entry) {
    const lines = [`[mcp_servers.telex]`, `command = "${entry.command}"`, `args = [${entry.args.map((a) => `"${a}"`).join(", ")}]`];
    if (entry.env) {
        lines.push(``, `[mcp_servers.telex.env]`, ...Object.entries(entry.env).map(([k, v]) => `${k} = "${v}"`));
    }
    return lines.join("\n");
}
const nest = (path, value) => path.reduceRight((acc, key) => ({ [key]: acc }), value);
/** Run the agent's own installer. Returns null when its binary is not on PATH. */
export function runCli(argv, cwd) {
    const run = spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8" });
    if (run.error && run.error.code === "ENOENT")
        return null;
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`.trim();
    return { ok: run.status === 0, how: argv.join(" "), output };
}
/** Merge the entry into the agent's config file, keeping whatever else is in there. */
export function writeFileConfig(agent, entry, dir, local) {
    const rel = (local && agent.localFile) || agent.file;
    const path = join(dir, rel);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const next = agent.toml ? mergeToml(existing, entry) : mergeJson(existing, agent, entry);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
    return { ok: true, how: `wrote ${rel}` };
}
function mergeJson(existing, agent, entry) {
    const root = existing.trim() ? JSON.parse(existing) : {};
    let node = root;
    for (const key of agent.path.slice(0, -1)) {
        if (typeof node[key] !== "object" || node[key] === null)
            node[key] = {};
        node = node[key];
    }
    node[agent.path[agent.path.length - 1]] = agent.value(entry);
    return `${JSON.stringify(root, null, 2)}\n`;
}
/** Replace an existing [mcp_servers.telex] block (and its sub-tables) or append a new one. */
export function mergeToml(existing, entry) {
    const lines = existing.split("\n");
    const start = lines.findIndex((l) => l.trim() === "[mcp_servers.telex]");
    if (start === -1) {
        const head = existing.trim();
        return `${head ? `${head}\n\n` : ""}${tomlBlock(entry)}\n`;
    }
    let end = start + 1;
    while (end < lines.length && !/^\s*\[/.test(lines[end]))
        end++;
    while (end < lines.length && lines[end].trim().startsWith("[mcp_servers.telex.")) {
        end++;
        while (end < lines.length && !/^\s*\[/.test(lines[end]))
            end++;
    }
    const merged = [...lines.slice(0, start), ...tomlBlock(entry).split("\n"), "", ...lines.slice(end)];
    return `${merged.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}
/** A local-only config is worthless if git picks it up anyway. */
export function ensureGitignored(dir, rel) {
    const path = join(dir, ".gitignore");
    const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
    const patterns = [rel, `/${rel}`, `${rel}/`];
    if (existing.split("\n").some((l) => patterns.includes(l.trim())))
        return null;
    writeFileSync(path, `${existing.replace(/\n*$/, "")}${existing.trim() ? "\n" : ""}${rel}\n`);
    return ".gitignore";
}
//# sourceMappingURL=agents.js.map