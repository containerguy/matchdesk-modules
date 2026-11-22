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
    .describe("Adresse des Billard-Servers für den Matchdesk-Server, z. B. http://bandenduell:3000/game-servers/billiard")
});

export type ArenaSettings = z.infer<typeof settings>;
