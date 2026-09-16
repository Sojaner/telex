import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agents, mergeToml, writeFileConfig, ensureGitignored, type Entry } from "../src/agents.ts";

const entry: Entry = { command: "telex", args: ["serve"], env: { TELEX_BOT: "main" } };
const dir = () => mkdtempSync(join(tmpdir(), "telex-"));
const agent = (id: string) => agents().find((a) => a.id === id)!;

test("json config keeps the keys already in the file", () => {
  const d = dir();
  writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));
  writeFileConfig(agent("claude"), entry, d, false);
  const written = JSON.parse(readFileSync(join(d, ".mcp.json"), "utf8"));
  assert.equal(written.mcpServers.other.command, "x");
  assert.deepEqual(written.mcpServers.telex, entry);
});

test("toml env goes in its own table and replaces an older block", () => {
  const block = mergeToml("", entry);
  assert.match(block, /\[mcp_servers\.telex\.env\]\nTELEX_BOT = "main"/);
  const again = mergeToml(`model = "gpt"\n\n${block}\n[other]\nkeep = 1\n`, { command: "telex", args: ["serve"] });
  assert.equal(again.match(/\[mcp_servers\.telex\]/g)!.length, 1);
  assert.doesNotMatch(again, /TELEX_BOT/);
  assert.match(again, /model = "gpt"/);
  assert.match(again, /\[other\]\nkeep = 1/);
});

test("local codex config lands in .gitignore exactly once", () => {
  const d = dir();
  mkdirSync(join(d, ".codex"));
  writeFileConfig(agent("codex"), entry, d, true);
  assert.match(readFileSync(join(d, ".codex/config.local.toml"), "utf8"), /mcp_servers\.telex/);
  assert.equal(ensureGitignored(d, ".codex/config.local.toml"), ".gitignore");
  assert.equal(ensureGitignored(d, ".codex/config.local.toml"), null);
  assert.equal(readFileSync(join(d, ".gitignore"), "utf8"), ".codex/config.local.toml\n");
});
