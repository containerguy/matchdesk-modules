import { z } from "zod";

export const settings = z.object({
  notifyOnCreate: z.boolean().default(true).describe("Bei neuer Abstimmung alle, die sie sehen, per Push benachrichtigen"),
  maxOptions: z.number().int().min(2).max(100).default(30).describe("Höchstens so viele Optionen pro Abstimmung")
});

export type PollsSettings = z.infer<typeof settings>;
