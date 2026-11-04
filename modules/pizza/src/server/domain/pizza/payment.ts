import type { MatchdeskSettings } from "../../settings";

export type PizzaPaymentMethod = "cash" | "paypal";

type PaymentSettings = Pick<MatchdeskSettings, "pizzaPaymentMethods" | "pizzaPaypalHandle">;

/**
 * Tatsächlich angebotene Bezahlarten. PayPal braucht zusätzlich ein gesetztes Handle; bleibt
 * nichts übrig, wird Bargeld angeboten, damit eine Bestellung immer bezahlbar bleibt.
 */
export function offeredPaymentMethods(settings: PaymentSettings): PizzaPaymentMethod[] {
  const mode = settings.pizzaPaymentMethods;
  const methods: PizzaPaymentMethod[] = [];
  if (mode !== "paypal_only") methods.push("cash");
  if (mode !== "cash_only" && settings.pizzaPaypalHandle.trim()) methods.push("paypal");
  return methods.length > 0 ? methods : ["cash"];
}

/** Bei genau einer angebotenen Bezahlart wird sie vorausgewählt, sonst wählt der Gast selbst. */
export function defaultPaymentMethod(offered: PizzaPaymentMethod[]): PizzaPaymentMethod | null {
  return offered.length === 1 ? offered[0] : null;
}
