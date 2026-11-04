import { describe, expect, it } from "vitest";
import {
  PIZZA_MAX_LINES_PER_ORDER,
  PizzaOrderLimitError,
  assertCanAddLine,
  assertValidNote,
  assertValidQty,
  normalizeNote
} from "./order-limits";

describe("pizza order limits", () => {
  it("allows adding line below max", () => {
    expect(() => assertCanAddLine([])).not.toThrow();
    expect(() => assertCanAddLine([{ id: "1" }, { id: "2" }])).not.toThrow();
  });

  it("rejects adding past max lines", () => {
    const lines = Array.from({ length: PIZZA_MAX_LINES_PER_ORDER }, (_, i) => ({
      id: `${i}`
    }));
    expect(() => assertCanAddLine(lines)).toThrow(PizzaOrderLimitError);
  });

  it("accepts qty in range", () => {
    expect(() => assertValidQty(1)).not.toThrow();
    expect(() => assertValidQty(3)).not.toThrow();
  });

  it("rejects qty out of range", () => {
    expect(() => assertValidQty(0)).toThrow(PizzaOrderLimitError);
    expect(() => assertValidQty(4)).toThrow(PizzaOrderLimitError);
    expect(() => assertValidQty(1.5)).toThrow(PizzaOrderLimitError);
    expect(() => assertValidQty(Number.NaN)).toThrow(PizzaOrderLimitError);
  });

  it("accepts notes within length", () => {
    expect(() => assertValidNote(null)).not.toThrow();
    expect(() => assertValidNote(undefined)).not.toThrow();
    expect(() => assertValidNote("short note")).not.toThrow();
    expect(() => assertValidNote("a".repeat(200))).not.toThrow();
  });

  it("rejects note over 200 chars", () => {
    expect(() => assertValidNote("a".repeat(201))).toThrow(PizzaOrderLimitError);
  });

  it("normalizes notes (trim, empty → null)", () => {
    expect(normalizeNote(null)).toBeNull();
    expect(normalizeNote(undefined)).toBeNull();
    expect(normalizeNote("")).toBeNull();
    expect(normalizeNote("   ")).toBeNull();
    expect(normalizeNote("  hello  ")).toBe("hello");
  });
});
