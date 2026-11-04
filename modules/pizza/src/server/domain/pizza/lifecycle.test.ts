import { describe, expect, it } from "vitest";
import {
  PizzaLifecycleError,
  canEditMenu,
  canMarkPayment,
  canPlaceOrder,
  nextState
} from "./lifecycle";

describe("pizza lifecycle nextState", () => {
  it("allows draft → open via open", () => {
    expect(nextState("draft", "open")).toBe("open");
  });

  it("allows open → locked via lock", () => {
    expect(nextState("open", "lock")).toBe("locked");
  });

  it("allows locked → delivered via deliver", () => {
    expect(nextState("locked", "deliver")).toBe("delivered");
  });

  it("allows locked → open via reopen", () => {
    expect(nextState("locked", "reopen")).toBe("open");
  });

  it("rejects illegal transitions", () => {
    expect(() => nextState("draft", "lock")).toThrow(PizzaLifecycleError);
    expect(() => nextState("open", "deliver")).toThrow(PizzaLifecycleError);
    expect(() => nextState("delivered", "reopen")).toThrow(PizzaLifecycleError);
    expect(() => nextState("locked", "open")).toThrow(PizzaLifecycleError);
  });
});

describe("pizza lifecycle guards", () => {
  it("only allows order placement while open", () => {
    expect(canPlaceOrder("draft")).toBe(false);
    expect(canPlaceOrder("open")).toBe(true);
    expect(canPlaceOrder("locked")).toBe(false);
    expect(canPlaceOrder("delivered")).toBe(false);
  });

  it("only allows payment marking once locked", () => {
    expect(canMarkPayment("draft")).toBe(false);
    expect(canMarkPayment("open")).toBe(false);
    expect(canMarkPayment("locked")).toBe(true);
    expect(canMarkPayment("delivered")).toBe(true);
  });

  it("allows menu editing when no session, draft, or open", () => {
    expect(canEditMenu(null)).toBe(true);
    expect(canEditMenu("draft")).toBe(true);
    expect(canEditMenu("open")).toBe(true);
    expect(canEditMenu("locked")).toBe(false);
    expect(canEditMenu("delivered")).toBe(false);
  });
});
