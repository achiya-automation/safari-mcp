#!/usr/bin/env node
// כמה זמן יושב תיקון שכבר במיין אבל עדיין לא שוחרר.
// מדפיס age_hours=<n> ל-GITHUB_OUTPUT. 0 = אין מה לשחרר.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** תוכן הסעיף [Unreleased] בלבד, בלי הכותרת ובלי הגרסה שאחריו. */
export function unreleasedBody(changelog) {
  const start = changelog.search(/^## \[Unreleased\]\s*$/m);
  if (start === -1) return "";
  const rest = changelog.slice(start).replace(/^## \[Unreleased\]\s*$/m, "");
  const next = rest.search(/^## \[/m);
  return (next === -1 ? rest : rest.slice(0, next)).trim();
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function main() {
  if (!unreleasedBody(readFileSync("CHANGELOG.md", "utf8"))) {
    console.log("age_hours=0");
    return;
  }
  // ponytail: התג האחרון לפי תאריך, לא לפי semver — התגים כאן נוצרים בסדר כרונולוגי.
  let tag = null;
  try {
    tag = git("describe", "--tags", "--abbrev=0");
  } catch {
    /* ריפו בלי תגים */
  }
  const range = tag ? `${tag}..HEAD` : "HEAD";
  const since = (...paths) =>
    git("log", range, "--format=%cI", "--", ...paths)
      .split("\n")
      .filter(Boolean)
      .at(-1);

  // נופלים אחורה ולא לאפס: [Unreleased] עם תוכן זה תמיד משהו שלא הופץ, וכשל-פתוח
  // כאן פירושו משקיף שותק בדיוק במקרה שהוא נועד לתפוס.
  const oldest = since("CHANGELOG.md") ?? since() ?? (tag && git("log", "-1", "--format=%cI", tag));
  if (!oldest) {
    console.log("age_hours=0");
    return;
  }
  console.log(`age_hours=${Math.floor((Date.now() - Date.parse(oldest)) / 36e5)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
