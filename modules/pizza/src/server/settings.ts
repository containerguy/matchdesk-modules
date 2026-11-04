/** Einstellungen des Moduls (src/settings.ts), in der Form, die der Domain-Code erwartet. */
export type MatchdeskSettings = {
  pizzaPaypalHandle: string;
  pizzaPaypalName: string;
  pizzaCashRecipient: string;
  pizzaPaymentMethods: "cash_and_paypal" | "cash_only" | "paypal_only";
};
