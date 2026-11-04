import { z } from "zod";

export const settings = z.object({
  includeLink: z.boolean().default(true).describe("Link zur App anhängen, wenn MATCHDESK_PUBLIC_URL gesetzt ist"),
  pollSeconds: z.number().int().min(2).max(60).default(3).describe("So oft fragt Matchdesk beim Bot nach neuen Nachrichten (Sekunden)")
});

export type TelegramSettings = z.infer<typeof settings>;
