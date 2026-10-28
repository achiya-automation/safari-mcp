// safari_snapshot diff mode (idea from PR #201 by @fahadjibransheikh). After a click or a fill an
// agent usually needs only what changed, and a full snapshot costs it the whole page again.
//
// A snapshot is cut into lines at line breaks and before block tags, and lines are compared as a
// multiset with their refs removed: refs are numbered in page order, so one element inserted near
// the top renumbers every ref after it. Added lines keep their fresh refs, which the agent can use.
// Removed lines are shown without refs, which are dead.

const MAX_TABS_REMEMBERED = 50;
const MAX_REMOVED_SHOWN = 50;

const _BLOCK_START = /\n|(?=<(?:li|p|h[1-6]|form|section|article|nav|header|footer|main|aside|dialog|ul|ol|button|label|tr)\b)/;
// ref="3_12" from the extension, ref=3_12 from the AppleScript snapshot.
const _REF = / ?\bref=("[^"]*"|\S+)/g;

export function snapshotLines(text) {
  return String(text).split(_BLOCK_START).map((line) => line.trim()).filter(Boolean);
}

export function withoutRefs(line) {
  return line.replace(_REF, "").trim();
}

export function diffSnapshots(previous, current) {
  const left = new Map();
  for (const line of snapshotLines(previous)) {
    const key = withoutRefs(line);
    left.set(key, (left.get(key) || 0) + 1);
  }
  const added = [];
  for (const line of snapshotLines(current)) {
    const key = withoutRefs(line);
    const count = left.get(key) || 0;
    if (count) left.set(key, count - 1);
    else added.push(`+ ${line}`);
  }
  const removed = [];
  for (const [key, count] of left) for (let i = 0; i < count; i++) removed.push(`- ${key}`);
  if (!added.length && !removed.length) return "No changes since the previous snapshot.";
  const shown = removed.slice(0, MAX_REMOVED_SHOWN);
  if (removed.length > shown.length) shown.push(`- … ${removed.length - shown.length} more removed lines`);
  return `Changes since the previous snapshot (${added.length} added, ${removed.length} removed):\n${[...added, ...shown].join("\n")}`;
}

// The last snapshot of each (session, tab, selector), newest kept, so a diff has a base.
export function createSnapshotMemory(limit = MAX_TABS_REMEMBERED) {
  const last = new Map();
  return {
    // Stores `text` under `key` and returns what was stored there before (undefined if nothing).
    swap(key, text) {
      const previous = last.get(key);
      last.delete(key);
      last.set(key, text);
      if (last.size > limit) last.delete(last.keys().next().value);
      return previous;
    },
    get size() {
      return last.size;
    },
    has: (key) => last.has(key),
  };
}

// The base of safari_snapshot diff:true for this process. In HTTP mode every session's server
// shares it; the key carries the session.
export const lastSnapshots = createSnapshotMemory();
