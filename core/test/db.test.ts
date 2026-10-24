import { describe, expect, it } from "vitest";
import { MIGRATIONS, ONLY_ADDS_FROM } from "../src/store/db";

/** A statement that adds to storage and takes nothing away: a table, an index, a column. */
const ADDS = /^(CREATE TABLE|CREATE INDEX|CREATE UNIQUE INDEX|CREATE VIRTUAL TABLE|ALTER TABLE \w+ ADD COLUMN)\b/i;

const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

describe("storage changes (§23.2)", () => {
  it("only add, from M7's on, so rolling the code back never breaks the data", () => {
    const later = MIGRATIONS.slice(ONLY_ADDS_FROM);
    expect(later.length).toBeGreaterThan(0);
    const refused = later.flatMap((m, i) =>
      statements(m)
        .filter((s) => !ADDS.test(s))
        .map((s) => `migration ${ONLY_ADDS_FROM + i + 1}: ${s}`),
    );
    expect(refused).toEqual([]);
  });

  it("add columns that older code can ignore: a default when they can't be empty", () => {
    const cols = MIGRATIONS.slice(ONLY_ADDS_FROM)
      .flatMap(statements)
      .filter((s) => /ADD COLUMN/i.test(s));
    expect(cols.filter((s) => /NOT NULL/i.test(s) && !/DEFAULT/i.test(s))).toEqual([]);
  });
});
