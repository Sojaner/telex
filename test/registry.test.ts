import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { touch, release, isLive, statePath, type Session } from "../src/registry.ts";

function isolated() {
  process.env.TELEX_STATE = join(mkdtempSync(join(tmpdir(), "telex-")), "sessions.json");
  return () => JSON.parse(readFileSync(statePath(), "utf8")).sessions as Session[];
}

const entry = (over: Partial<Session> = {}) => ({
  bot: "work",
  project: "/code/acme",
  agent: "claude-code",
  pid: process.pid,
  interval_seconds: 60,
  ...over,
});

test("a second agent on the same bot is reported to the first", (t) => {
  const sessions = isolated();
  t.after(() => release(process.pid));

  assert.deepEqual(touch(entry()), [], "nothing else is running yet");

  // A live process is needed for the liveness check; this test's own pid is the honest choice.
  const others = touch(entry({ pid: process.pid, project: "/code/other", agent: "codex" }));
  assert.equal(sessions().length, 1, "same pid and bot replaces its own record");
  assert.deepEqual(others, []);
});

test("two live processes on one bot see each other; a different bot does not", (t) => {
  const sessions = isolated();
  t.after(() => release(process.pid));

  writeFileSync(
    statePath(),
    JSON.stringify({
      sessions: [
        { ...entry({ pid: process.ppid, project: "/code/other", agent: "codex" }), started_at: new Date().toISOString(), last_seen: new Date().toISOString() },
        { ...entry({ pid: process.ppid, bot: "alerts", project: "/code/third" }), started_at: new Date().toISOString(), last_seen: new Date().toISOString() },
      ],
    }),
  );

  const others = touch(entry());
  assert.deepEqual(others.map((s) => s.project), ["/code/other"], "only the same bot counts");
  assert.equal(sessions().length, 3);
});

test("a dead process is forgotten rather than warned about", (t) => {
  const sessions = isolated();
  t.after(() => release(process.pid));
  const stamp = new Date().toISOString();
  // PID 1 exists but is not ours; a never-allocated high pid stands in for a crashed agent.
  writeFileSync(
    statePath(),
    JSON.stringify({ sessions: [{ ...entry({ pid: 2 ** 22, project: "/code/gone" }), started_at: stamp, last_seen: stamp }] }),
  );

  assert.deepEqual(touch(entry()), []);
  assert.deepEqual(sessions().map((s) => s.project), ["/code/acme"]);
});

test("a live process that stopped checking in is stale after three intervals", () => {
  const now = Date.now();
  const session: Session = {
    ...entry({ interval_seconds: 30 }),
    started_at: new Date(now).toISOString(),
    last_seen: new Date(now - 100_000).toISOString(),
  };
  assert.equal(isLive(session, now), false, "100s is past three 30s beats");
  assert.equal(isLive({ ...session, last_seen: new Date(now - 60_000).toISOString() }, now), true);
});

test("started_at survives a re-check-in, last_seen moves", (t) => {
  const sessions = isolated();
  t.after(() => release(process.pid));
  touch(entry(), Date.parse("2026-09-15T10:00:00.000Z"));
  touch(entry(), Date.parse("2026-09-15T10:05:00.000Z"));
  const [mine] = sessions();
  assert.equal(mine.started_at, "2026-09-15T10:00:00.000Z");
  assert.equal(mine.last_seen, "2026-09-15T10:05:00.000Z");
});
