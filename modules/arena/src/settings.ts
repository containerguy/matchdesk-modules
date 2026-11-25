import { z } from "zod";

export const settings = z.object({
  callbackBaseUrl: z
    .string()
    .max(300)
    .default("")
    .describe("Adresse, unter der die Spielserver Matchdesk erreichen (für Ergebnisse), z. B. http://matchdesk:3000"),
  billiardEnabled: z.boolean().default(true).describe("Billard anbieten"),
  billiardPath: z
    .string()
    .max(200)
    .default("/game-servers/billiard/")
    .describe("Pfad des Billard-Servers unter derselben Adresse wie Matchdesk (Location im Reverse Proxy)"),
  billiardApiUrl: z
    .string()
    .max(300)
    .default("")
    .describe("Adresse des Billard-Servers für den Matchdesk-Server, z. B. http://bandenduell:3000/game-servers/billiard"),
  shiftEnabled: z.boolean().default(true).describe("Dreierschub anbieten"),
  shiftPath: z
    .string()
    .max(200)
    .default("/game-servers/shift/")
    .describe("Pfad des Dreierschub-Servers unter derselben Adresse wie Matchdesk (Location im Reverse Proxy)"),
  shiftApiUrl: z
    .string()
    .max(300)
    .default("")
    .describe("Adresse des Dreierschub-Servers für den Matchdesk-Server, z. B. http://shift:3000/game-servers/shift")
});

export type ArenaSettings = z.infer<typeof settings>;
