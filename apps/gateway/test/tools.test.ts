import { describe, expect, test } from "bun:test";
import { isDestructiveSql } from "../src/tools";

/**
 * §7.3 — execute_sql must let routine work through but block irreversible loss
 * on the live company DB (DROP / TRUNCATE / ALTER…DROP), including via comments
 * or multi-statement strings.
 */
describe("isDestructiveSql", () => {
  test("allows routine DML/DDL", () => {
    for (const sql of [
      "SELECT * FROM customers",
      "INSERT INTO customers (email) VALUES ('a@x.com')",
      "UPDATE customers SET email = 'b@x.com' WHERE id = 1",
      "DELETE FROM customers WHERE id = 1",
      "CREATE TABLE leads (id serial primary key, email text)",
      "ALTER TABLE customers ADD COLUMN phone text",
    ]) {
      expect(isDestructiveSql(sql)).toBe(false);
    }
  });

  test("blocks destructive statements", () => {
    for (const sql of [
      "DROP TABLE customers",
      "drop table customers",
      "TRUNCATE customers",
      "ALTER TABLE customers DROP COLUMN email",
      "DROP SCHEMA public CASCADE",
    ]) {
      expect(isDestructiveSql(sql)).toBe(true);
    }
  });

  test("is not fooled by comments or trailing statements", () => {
    expect(isDestructiveSql("-- harmless\nDROP TABLE customers")).toBe(true);
    expect(isDestructiveSql("SELECT 1; DROP TABLE customers")).toBe(true);
    expect(isDestructiveSql("/* x */ TRUNCATE t")).toBe(true);
  });
});
