import { z } from "zod";

export const settings = z.object({
  greeting: z.string().min(1).max(120).default("Hallo und willkommen!").describe("Begrüßung oben auf der Seite"),
  maxNotes: z.number().int().min(1).max(200).default(20).describe("So viele Notizen zeigt die Pinnwand"),
  notifyOnPost: z.boolean().default(false).describe("Bei neuer Notiz alle mit Leserecht per Push benachrichtigen")
});

export type HalloSettings = z.infer<typeof settings>;
