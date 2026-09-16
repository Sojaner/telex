/**
 * Which agents are alive, on disk, so separate telex processes can see each other.
 * Each project's agent runs its own server; only a shared file can tell them apart.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export const statePath = () => process.env.TELEX_STATE ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "telex", "sessions.json");
const read = () => {
    try {
        const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
        return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
    }
    catch {
        return []; // a missing or corrupt file just means nothing is registered
    }
};
const write = (sessions) => {
    const path = statePath();
    mkdirSync(dirname(path), { recursive: true });
    // ponytail: write-rename, no lock. Two agents registering in the same millisecond can lose one
    // record; it reappears on that agent's next call. Use a lockfile if that ever matters.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
};
const running = (pid) => {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
};
/** A session counts as alive while its process exists and it has checked in within three intervals. */
export function isLive(session, now) {
    const grace = Math.max(session.interval_seconds * 3, 60) * 1000;
    return running(session.pid) && now - Date.parse(session.last_seen) <= grace;
}
/**
 * Record this agent and return the other live agents on the same bot. Two of them polling one
 * token split the updates between themselves, so the caller warns the user about the ones returned.
 */
export function touch(entry, now = Date.now()) {
    const stamp = new Date(now).toISOString();
    const others = read().filter((s) => !(s.pid === entry.pid && s.bot === entry.bot) && isLive(s, now));
    const mine = read().find((s) => s.pid === entry.pid && s.bot === entry.bot);
    write([...others, { ...entry, started_at: mine?.started_at ?? stamp, last_seen: stamp }]);
    return others.filter((s) => s.bot === entry.bot);
}
/** Drop this process's record. Best effort — a crash is covered by the liveness check instead. */
export function release(pid = process.pid) {
    try {
        write(read().filter((s) => s.pid !== pid));
    }
    catch {
        // nothing useful to do while exiting
    }
}
//# sourceMappingURL=registry.js.map