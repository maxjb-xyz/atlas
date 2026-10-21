import { expect, it } from "vitest";
import { newId } from "../src/store/db";
it("makes prefixed ids", () => {
  expect(newId("run")).toMatch(/^run_[0-9a-z]+$/);
});
