import { describe, expect, it } from "vitest";
import { defaultPaymentMethod, offeredPaymentMethods } from "./payment";

describe("offeredPaymentMethods", () => {
  it("bietet Bargeld und PayPal an, wenn ein Handle gesetzt ist", () => {
    expect(
      offeredPaymentMethods({ pizzaPaymentMethods: "cash_and_paypal", pizzaPaypalHandle: "rene" })
    ).toEqual(["cash", "paypal"]);
  });

  it("lässt PayPal ohne Handle weg", () => {
    expect(
      offeredPaymentMethods({ pizzaPaymentMethods: "cash_and_paypal", pizzaPaypalHandle: " " })
    ).toEqual(["cash"]);
  });

  it("respektiert nur Bargeld", () => {
    expect(
      offeredPaymentMethods({ pizzaPaymentMethods: "cash_only", pizzaPaypalHandle: "rene" })
    ).toEqual(["cash"]);
  });

  it("fällt bei nur PayPal ohne Handle auf Bargeld zurück", () => {
    expect(
      offeredPaymentMethods({ pizzaPaymentMethods: "paypal_only", pizzaPaypalHandle: "" })
    ).toEqual(["cash"]);
    expect(
      offeredPaymentMethods({ pizzaPaymentMethods: "paypal_only", pizzaPaypalHandle: "rene" })
    ).toEqual(["paypal"]);
  });
});

describe("defaultPaymentMethod", () => {
  it("wählt nur bei eindeutiger Bezahlart vor", () => {
    expect(defaultPaymentMethod(["cash"])).toBe("cash");
    expect(defaultPaymentMethod(["cash", "paypal"])).toBeNull();
  });
});
