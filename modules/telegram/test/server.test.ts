import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModuleContext } from "@matchdesk/module-sdk";
import { createTestModule, type TestModule } from "@matchdesk/module-sdk/testing";
import { composeTelegram } from "../src/message";
import { setup } from "../src/server";

const moduleDir = path.resolve(import.meta.dirname, "..");
let module: TestModule | undefined;

type Sent = { chat_id: string | number; text: string };

function fakeTelegram(options: { failSendWith?: { code: number; description: string } } = {}) {
  const fake = { updates: [] as unknown[], sent: [] as Sent[], calls: [] as string[] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const method = url.split("/").pop()!;
      fake.calls.push(url);
      const body = JSON.parse(String(init.body ?? "{}"));
      const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
      if (method === "getMe") return ok({ id: 1, is_bot: true, username: "LanBot" });
      if (method === "getUpdates") {
        const pending = fake.updates.filter((update) => (update as { update_id: number }).update_id >= (body.offset ?? 0));
        fake.updates = [];
        return ok(pending);
      }
      if (method === "sendMessage") {
        if (options.failSendWith && body.chat_id !== 999) {
          return new Response(JSON.stringify({ ok: false, error_code: options.failSendWith.code, description: options.failSendWith.description }), {
            status: options.failSendWith.code
          });
        }
        fake.sent.push({ chat_id: body.chat_id, text: body.text });
        return ok({ message_id: fake.sent.length });
      }
      return new Response(JSON.stringify({ ok: false, description: "unbekannt" }), { status: 404 });
    })
  );
  return fake;
}

async function start(options: { token?: string | null } = {}) {
  let bot!: ReturnType<typeof setup>;
  module = await createTestModule({
    moduleDir,
    register: (ctx: ModuleContext) => {
      bot = setup(ctx);
    },
    secrets: options.token === null ? {} : { TELEGRAM_BOT_TOKEN: options.token ?? "123:geheim" }
  });
  return { mod: module, bot };
}

function startMessage(updateId: number, chatId: number, text: string, username = "anna_tg") {
  return { update_id: updateId, message: { text, chat: { id: chatId, type: "private" }, from: { username, language_code: "de" } } };
}

async function linkAnna(mod: TestModule, bot: ReturnType<typeof setup>, fake: ReturnType<typeof fakeTelegram>, chatId = 4711) {
  const { body } = await request(mod.app).post("/api/m/telegram/link").set("x-test-user", "anna").send({}).expect(200);
  expect(body.url).toMatch(/^https:\/\/t\.me\/LanBot\?start=[A-Za-z0-9_-]{24}$/);
  const code = new URL(body.url).searchParams.get("start")!;
  fake.updates.push(startMessage(10 + chatId, chatId, `/start ${code}`));
  await bot.pollOnce();
  return code;
}

afterEach(async () => {
  await module?.stop();
  module = undefined;
  vi.unstubAllGlobals();
});

describe("Telegram-Nachricht", () => {
  it("setzt den Kopf fett, entschärft HTML und hängt den Link an", () => {
    expect(
      composeTelegram({ eventName: "LAN <1>", subject: "Pizza & Cola", body: "Bis 18 Uhr <bestellen>", url: "https://md.example/#e" }, { includeLink: true })
    ).toBe('<b>LAN &lt;1&gt;: Pizza &amp; Cola</b>\n\nBis 18 Uhr &lt;bestellen&gt;\n\n<a href="https://md.example/#e">Matchdesk</a>');
    expect(composeTelegram({ eventName: "LAN", subject: "x", body: "", url: "javascript:alert(1)" }, { includeLink: true })).toBe("<b>LAN: x</b>");
  });
});

describe("Modul Telegram", () => {
  it("verknüpft ein Konto über den Start-Link und stellt danach Event-Infos zu", async () => {
    const fake = fakeTelegram();
    const { mod, bot } = await start();
    expect(await mod.notify("telegram", "anna")).toBe("unavailable");

    await linkAnna(mod, bot, fake);
    expect(fake.sent.at(-1)).toEqual(expect.objectContaining({ chat_id: "4711", text: expect.stringContaining("<b>anna</b>") }));
    const me = (await request(mod.app).get("/api/m/telegram/me").set("x-test-user", "anna").expect(200)).body;
    expect(me).toEqual(expect.objectContaining({ configured: true, botUsername: "LanBot", linked: true, telegramUsername: "anna_tg" }));
    expect(mod.broadcasts).toContainEqual({ event: "link_changed", data: undefined });

    expect(await mod.notify("telegram", "anna", { subject: "Pizza", body: "Bis 18 Uhr" })).toBe("sent");
    expect(fake.sent.at(-1)).toEqual({
      chat_id: "4711",
      text: '<b>Test-LAN: Pizza</b>\n\nBis 18 Uhr\n\n<a href="https://matchdesk.example.test/#main-events">Matchdesk</a>'
    });
    // Der Token steht nur in der URL zur Bot-API.
    expect(fake.calls.every((url) => url.startsWith("https://api.telegram.org/bot123:geheim/"))).toBe(true);
  });

  it("nimmt jeden Code nur einmal und lehnt abgelaufene ab", async () => {
    const fake = fakeTelegram();
    const { mod, bot } = await start();
    const code = await linkAnna(mod, bot, fake);
    // Derselbe Code aus einem anderen Chat verknüpft nichts.
    fake.updates.push(startMessage(5000, 5555, `/start ${code}`, "mallory"));
    await bot.pollOnce();
    expect(fake.sent.at(-1)).toEqual(expect.objectContaining({ chat_id: "5555", text: expect.stringContaining("abgelaufen") }));
    expect(mod.db.prepare("SELECT chat_id FROM telegram_links").all()).toEqual([{ chat_id: "4711" }]);

    const { body } = await request(mod.app).post("/api/m/telegram/link").set("x-test-user", "max").send({}).expect(200);
    mod.db.prepare("UPDATE telegram_link_codes SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    fake.updates.push(startMessage(5001, 6666, `/start ${new URL(body.url).searchParams.get("start")}`, "max_tg"));
    await bot.pollOnce();
    expect(mod.db.prepare("SELECT COUNT(*) AS count FROM telegram_links").get()).toEqual({ count: 1 });
  });

  it("löst die Verknüpfung per /stop, im Profil und wenn der Bot blockiert wurde", async () => {
    let fake = fakeTelegram();
    let started = await start();
    await linkAnna(started.mod, started.bot, fake);
    fake.updates.push(startMessage(5002, 4711, "/stop"));
    await started.bot.pollOnce();
    expect(await started.mod.notify("telegram", "anna")).toBe("unavailable");

    await linkAnna(started.mod, started.bot, fake);
    await request(started.mod.app).delete("/api/m/telegram/link").set("x-test-user", "anna").expect(204);
    expect(await started.mod.notify("telegram", "anna")).toBe("unavailable");
    await started.mod.stop();
    vi.unstubAllGlobals();

    fake = fakeTelegram({ failSendWith: { code: 403, description: "Forbidden: bot was blocked by the user" } });
    started = await start();
    started.mod.db.prepare("INSERT INTO telegram_links (user_id, chat_id, linked_at) VALUES (?, '4711', ?)").run(started.mod.userId("anna"), new Date().toISOString());
    expect(await started.mod.notify("telegram", "anna")).toMatch(/blocked by the user/);
    expect(await started.mod.notify("telegram", "anna")).toBe("unavailable");
    expect((await request(started.mod.app).get("/api/m/telegram/me").set("x-test-user", "anna")).body.blocked).toBe(true);
  });

  it("ist ohne Token oder ohne Recht nicht erreichbar", async () => {
    fakeTelegram();
    let started = await start({ token: null });
    await request(started.mod.app).post("/api/m/telegram/link").set("x-test-user", "anna").send({}).expect(409);
    expect((await request(started.mod.app).get("/api/m/telegram/me").set("x-test-user", "anna")).body.configured).toBe(false);
    await started.mod.stop();

    const fake = fakeTelegram();
    started = await start();
    await linkAnna(started.mod, started.bot, fake);
    started.mod.manifest.permissions.find((permission) => permission.key === "telegram.receive")!.defaultRoles = [];
    expect(await started.mod.notify("telegram", "anna")).toBe("unavailable");
    await request(started.mod.app).get("/api/m/telegram/me").set("x-test-user", "anna").expect(403);
  });

  it("antwortet auf andere Nachrichten mit einer Anleitung und ignoriert Gruppen", async () => {
    const fake = fakeTelegram();
    const { bot } = await start();
    fake.updates.push(startMessage(300, 1, "hallo"));
    fake.updates.push({ update_id: 301, message: { text: "/start x", chat: { id: -100, type: "group" } } });
    await bot.pollOnce();
    expect(fake.sent).toEqual([expect.objectContaining({ chat_id: "1", text: expect.stringContaining("Telegram verknüpfen") })]);
    expect(bot.state.offset).toBe(302);
  });

  it("zeigt Admins den Stand und schickt eine Testnachricht", async () => {
    const fake = fakeTelegram();
    const { mod, bot } = await start();
    await request(mod.app).get("/api/m/telegram/admin/status").set("x-test-user", "anna").expect(403);
    let status = (await request(mod.app).get("/api/m/telegram/admin/status").set("x-test-user", "admin").expect(200)).body;
    expect(status).toEqual(expect.objectContaining({ configured: true, botUsername: "LanBot", linked: 0, ownLinked: false }));
    await request(mod.app).post("/api/m/telegram/admin/test").set("x-test-user", "admin").send({}).expect(502);

    const { body } = await request(mod.app).post("/api/m/telegram/link").set("x-test-user", "admin").send({}).expect(200);
    fake.updates.push(startMessage(400, 999, `/start ${new URL(body.url).searchParams.get("start")}`, "rene"));
    await bot.pollOnce();
    await request(mod.app).post("/api/m/telegram/admin/test").set("x-test-user", "admin").send({}).expect(200);
    expect(fake.sent.at(-1)).toEqual(expect.objectContaining({ chat_id: "999", text: expect.stringContaining("Testnachricht") }));
    status = (await request(mod.app).get("/api/m/telegram/admin/status").set("x-test-user", "admin").expect(200)).body;
    expect(status).toEqual(expect.objectContaining({ linked: 1, ownLinked: true, error: null }));
  });

  it("räumt beim Deinstallieren alle eigenen Tabellen weg", async () => {
    fakeTelegram();
    const { mod } = await start();
    mod.db.exec(fs.readFileSync(path.join(moduleDir, "uninstall.sql"), "utf8"));
    const left = mod.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'telegram\\_%' ESCAPE '\\'").all();
    expect(left).toEqual([]);
  });
});
