import { z } from "zod";

export const settings = z.object({
  apiUrl: z
    .string()
    .url()
    .max(300)
    .default("https://api.sms-gate.app/3rdparty/v1/messages")
    .describe("Adresse zum Senden. Cloud: https://api.sms-gate.app/3rdparty/v1/messages, Heimnetz: http://<IP-des-Handys>:8080/message"),
  username: z.string().max(120).default("").describe("Benutzername aus der App (Passwort als Umgebungsvariable MATCHDESK_SMS_PASSWORD)"),
  deviceId: z.string().max(120).default("").describe("Geräte-ID aus der App, nur nötig bei mehreren Handys im Konto"),
  countryCode: z
    .string()
    .regex(/^\+[1-9]\d{0,3}$/)
    .default("+49")
    .describe("Vorwahl für Nummern ohne Ländervorwahl (z. B. 0171… wird +49171…)"),
  maxLength: z.number().int().min(70).max(918).default(306).describe("Höchstens so viele Zeichen pro Nachricht (306 = zwei SMS)"),
  dailyLimit: z.number().int().min(1).max(5000).default(100).describe("Höchstens so viele SMS pro Tag (Schutz vor Kosten)"),
  includeLink: z.boolean().default(true).describe("Link zur App anhängen, wenn MATCHDESK_PUBLIC_URL gesetzt ist")
});

export type SmsSettings = z.infer<typeof settings>;
