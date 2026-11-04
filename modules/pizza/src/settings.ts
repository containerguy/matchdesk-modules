import { z } from "zod";

export const settings = z.object({
  paymentMethods: z
    .enum(["cash_and_paypal", "cash_only", "paypal_only"])
    .default("cash_and_paypal")
    .describe("Angebotene Bezahlarten (PayPal nur mit PayPal-Handle)"),
  paypalHandle: z.string().trim().max(80).default("").describe("PayPal-Handle für paypal.me/<handle> (leer = kein PayPal)"),
  paypalName: z.string().trim().max(120).default("").describe("Name des PayPal-Empfängers auf der Kassenliste"),
  cashRecipient: z.string().trim().max(120).default("").describe("Wer das Bargeld einsammelt (Hinweis auf der Kassenliste)")
});

export type PizzaSettings = z.infer<typeof settings>;
