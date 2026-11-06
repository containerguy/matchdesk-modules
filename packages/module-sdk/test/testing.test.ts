import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createTestModule } from "../src/testing";

const halloDir = path.resolve(import.meta.dirname, "../../../modules/hallo");

describe("createTestModule: Benachrichtigungskanäle", () => {
  it("meldet Kanäle an, stellt zu und meldet sie beim Stoppen ab", async () => {
    const sent: Array<{ to: string; text: string }> = [];
    const module = await createTestModule({
      moduleDir: halloDir,
      users: [
        { username: "anna", phoneNumber: "+491701111111" },
        { username: "ohne" }
      ],
      register: (ctx) => {
        ctx.notifications.registerChannel({
          id: "hallosms",
          label: { de: "SMS", en: "Text message" },
          isAvailable: (user) => Boolean(user.phoneNumber),
          send: async (user, message) => {
            if (message.subject === "kaputt") throw new Error("Gateway nicht erreichbar");
            sent.push({ to: user.phoneNumber, text: `${message.subject}: ${message.body} ${message.url}` });
          }
        });
      }
    });

    expect(await module.notify("hallosms", "anna", { subject: "Pizza", body: "um 20 Uhr" })).toBe("sent");
    expect(sent).toEqual([{ to: "+491701111111", text: "Pizza: um 20 Uhr https://matchdesk.example.test/#main-events" }]);
    expect(await module.notify("hallosms", "ohne")).toBe("unavailable");
    expect(await module.notify("hallosms", "anna", { subject: "kaputt" })).toBe("Gateway nicht erreichbar");

    await module.stop();
    expect(module.channels.size).toBe(0);
  });

  it("lehnt Kanal-IDs ab, die nicht mit der Modul-ID beginnen", async () => {
    await expect(
      createTestModule({
        moduleDir: halloDir,
        register: (ctx) =>
          ctx.notifications.registerChannel({ id: "sms", label: { de: "SMS", en: "SMS" }, isAvailable: () => true, send: async () => undefined })
      })
    ).rejects.toThrow(/muss mit der Modul-ID hallo beginnen/);
  });
});

describe("createTestModule: roher Body", () => {
  it("liefert den unveränderten JSON-Body über ctx.rawBody", async () => {
    const module = await createTestModule({
      moduleDir: halloDir,
      register: (ctx) => {
        ctx.router.post("/roh", (req, res) => {
          const raw = ctx.rawBody?.(req);
          res.json({ body: req.body, raw: raw ? raw.toString("utf8") : null });
        });
      }
    });
    const raw = '{ "z":1,"a" : "\\u00e4" }';
    const response = await request(module.app).post("/api/m/hallo/roh").set("Content-Type", "application/json").send(raw).expect(200);
    expect(response.body).toEqual({ body: { z: 1, a: "ä" }, raw });
    await module.stop();
  });

  it("simuliert ältere Kerne ohne ctx.rawBody", async () => {
    const module = await createTestModule({ moduleDir: halloDir, withoutRawBody: true });
    expect(module.ctx.rawBody).toBeUndefined();
    await module.stop();
  });
});
