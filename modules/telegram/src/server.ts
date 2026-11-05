import { randomBytes } from "node:crypto";
import type { ModuleContext, ModuleUser } from "@matchdesk/module-sdk";
import { composeTelegram, escapeHtml } from "./message";
import type { TelegramSettings } from "./settings";

const API = "https://api.telegram.org";
const CODE_MINUTES = 15;
const REQUEST_TIMEOUT_MS = 15_000;

type TelegramUpdate = {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string }; from?: { username?: string; language_code?: string } };
};
type LinkRow = { user_id: string; chat_id: string; telegram_username: string | null; linked_at: string; blocked_at: string | null };

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: number | null
  ) {
    super(message);
  }
}

/** Bot, Verknüpfung und Kanal. `register` startet ihn, Tests rufen `setup` direkt auf (für `pollOnce`). */
export function setup(ctx: ModuleContext) {
  const settings = () => ctx.settings.get() as TelegramSettings;
  const token = () => ctx.env("TELEGRAM_BOT_TOKEN") ?? "";
  const state = { botUsername: null as string | null, offset: 0, polling: false, lastError: null as string | null, lastPollAt: null as string | null };

  async function call<T>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
    const response = await ctx.http.fetch(`${API}/bot${token()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string; error_code?: number };
    if (!data.ok) {
      // Den Token nie in Fehlermeldungen tragen.
      throw new TelegramError(`Telegram: ${data.description ?? `HTTP ${response.status}`}`.slice(0, 200), data.error_code ?? response.status);
    }
    return data.result as T;
  }

  async function botUsername() {
    if (!state.botUsername && token()) {
      const me = await call<{ username?: string }>("getMe");
      state.botUsername = me.username ?? null;
    }
    return state.botUsername;
  }

  const linkOf = (userId: string) => ctx.db.prepare("SELECT * FROM telegram_links WHERE user_id = ?").get(userId) as LinkRow | undefined;

  function reply(chatId: number | string, text: string) {
    return call("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" }).catch((error) => ctx.log.warn("Antwort an Telegram fehlgeschlagen", error));
  }

  async function handleUpdate(update: TelegramUpdate) {
    const message = update.message;
    if (!message?.text || message.chat.type !== "private") return;
    const chatId = String(message.chat.id);
    const english = message.from?.language_code?.startsWith("en") ?? false;
    const [command, argument] = message.text.trim().split(/\s+/, 2);

    if (command === "/start" && argument) {
      const now = new Date().toISOString();
      const code = ctx.db.prepare("SELECT user_id FROM telegram_link_codes WHERE code = ? AND expires_at > ?").get(argument, now) as
        | { user_id: string }
        | undefined;
      ctx.db.prepare("DELETE FROM telegram_link_codes WHERE code = ? OR expires_at <= ?").run(argument, now);
      if (!code) {
        await reply(chatId, english ? "This link has expired. Open Telegram in Matchdesk and link again." : "Der Link ist abgelaufen. Öffne in Matchdesk den Menüpunkt Telegram und verknüpfe neu.");
        return;
      }
      ctx.db.transaction(() => {
        // Ein Chat gehört zu genau einem Konto: alte Verknüpfungen dieses Chats lösen.
        ctx.db.prepare("DELETE FROM telegram_links WHERE chat_id = ? OR user_id = ?").run(chatId, code.user_id);
        ctx.db
          .prepare("INSERT INTO telegram_links (user_id, chat_id, telegram_username, linked_at, blocked_at) VALUES (?, ?, ?, ?, NULL)")
          .run(code.user_id, chatId, message.from?.username ?? null, now);
      })();
      const user = ctx.db.prepare("SELECT username FROM users WHERE id = ?").get(code.user_id) as { username: string } | undefined;
      ctx.audit({ actor: null, action: "linked", summary: `Telegram mit ${user?.username ?? "Benutzer"} verknüpft`, entityId: code.user_id });
      ctx.realtime.broadcast("link_changed");
      await reply(
        chatId,
        english
          ? `Linked with Matchdesk account <b>${escapeHtml(user?.username ?? "")}</b>. Turn on Telegram under Profile › Notifications. Send /stop to unlink.`
          : `Verknüpft mit dem Matchdesk-Konto <b>${escapeHtml(user?.username ?? "")}</b>. Schalte Telegram jetzt im Profil unter Benachrichtigungen ein. Mit /stop löst du die Verknüpfung.`
      );
      return;
    }

    if (command === "/stop") {
      const link = ctx.db.prepare("SELECT user_id FROM telegram_links WHERE chat_id = ?").get(chatId) as { user_id: string } | undefined;
      ctx.db.prepare("DELETE FROM telegram_links WHERE chat_id = ?").run(chatId);
      if (link) ctx.realtime.broadcast("link_changed");
      await reply(chatId, english ? "Unlinked. You will get no more messages here." : "Verknüpfung gelöst. Hier kommen keine Nachrichten mehr.");
      return;
    }

    await reply(
      chatId,
      english
        ? "Hi! To get event updates here, open Telegram in Matchdesk and click “Link Telegram”."
        : "Hallo! Für Event-Infos hier öffne in Matchdesk den Menüpunkt Telegram und klicke auf „Telegram verknüpfen“."
    );
  }

  /** Neue Nachrichten an den Bot abholen (kurzes Polling, braucht keine öffentliche Adresse). */
  async function pollOnce() {
    if (!token() || state.polling) return;
    state.polling = true;
    try {
      const updates = await call<TelegramUpdate[]>("getUpdates", { offset: state.offset, timeout: 0, allowed_updates: ["message"] });
      for (const update of updates) {
        state.offset = Math.max(state.offset, update.update_id + 1);
        try {
          await handleUpdate(update);
        } catch (error) {
          ctx.log.error("Telegram-Nachricht nicht verarbeitet", error);
        }
      }
      state.lastError = null;
    } catch (error) {
      state.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      state.lastPollAt = new Date().toISOString();
      state.polling = false;
    }
  }

  async function sendTo(user: ModuleUser, text: string) {
    const link = linkOf(user.id);
    if (!link || link.blocked_at) throw new Error("Telegram ist nicht verknüpft");
    try {
      await call("sendMessage", { chat_id: link.chat_id, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      // 403: Bot blockiert oder Chat gelöscht. Dann nicht weiter versuchen, bis neu verknüpft wird.
      if (error instanceof TelegramError && error.code === 403) {
        ctx.db.prepare("UPDATE telegram_links SET blocked_at = ? WHERE user_id = ?").run(new Date().toISOString(), user.id);
      }
      throw error;
    }
  }

  ctx.notifications.registerChannel({
    id: "telegram",
    label: { de: "Telegram", en: "Telegram" },
    isAvailable: (user) => {
      if (!token() || !ctx.can(user, "telegram.receive")) return false;
      const link = linkOf(user.id);
      return Boolean(link && !link.blocked_at);
    },
    unavailableHint: {
      de: "Erst im Menüpunkt Telegram dein Konto verknüpfen.",
      en: "Link your account under Telegram in the menu first."
    },
    send: (user, message) => sendTo(user, composeTelegram(message, settings()))
  });

  // ---------- Seite für Benutzer ----------

  ctx.router.get("/me", async (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return void response.status(401).json({ error: "nicht_angemeldet" });
    if (!ctx.can(user, "telegram.receive")) return void response.status(403).json({ error: "recht_fehlt" });
    const link = linkOf(user.id);
    response.json({
      configured: Boolean(token()),
      botUsername: await botUsername().catch(() => null),
      linked: Boolean(link),
      blocked: Boolean(link?.blocked_at),
      telegramUsername: link?.telegram_username ?? null,
      linkedAt: link?.linked_at ?? null
    });
  });

  ctx.router.post("/link", async (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    if (!ctx.can(user, "telegram.receive")) return void response.status(403).json({ error: "recht_fehlt" });
    if (!token()) return void response.status(409).json({ error: "nicht_eingerichtet" });
    const bot = await botUsername().catch(() => null);
    if (!bot) return void response.status(502).json({ error: "bot_nicht_erreichbar" });
    const code = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();
    ctx.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(user.id);
    ctx.db.prepare("INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)").run(code, user.id, expiresAt);
    response.json({ url: `https://t.me/${bot}?start=${code}`, expiresAt });
  });

  ctx.router.delete("/link", (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    ctx.db.prepare("DELETE FROM telegram_links WHERE user_id = ?").run(user.id);
    ctx.db.prepare("DELETE FROM telegram_link_codes WHERE user_id = ?").run(user.id);
    response.status(204).end();
  });

  // ---------- Admin ----------

  ctx.router.get("/admin/status", async (request, response) => {
    const user = ctx.currentUser(request);
    if (!user) return void response.status(401).json({ error: "nicht_angemeldet" });
    if (!ctx.can(user, "telegram.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    const counts = ctx.db
      .prepare("SELECT COUNT(*) AS linked, SUM(CASE WHEN blocked_at IS NOT NULL THEN 1 ELSE 0 END) AS blocked FROM telegram_links")
      .get() as { linked: number; blocked: number | null };
    let botError: string | null = null;
    const bot = await botUsername().catch((error: Error) => {
      botError = error.message;
      return null;
    });
    response.json({
      configured: Boolean(token()),
      botUsername: bot,
      linked: counts.linked,
      blocked: counts.blocked ?? 0,
      ownLinked: Boolean(linkOf(user.id) && !linkOf(user.id)?.blocked_at),
      lastPollAt: state.lastPollAt,
      error: botError ?? state.lastError
    });
  });

  ctx.router.post("/admin/test", async (request, response) => {
    if (!ctx.requireWrite(request, response)) return;
    const user = ctx.currentUser(request)!;
    if (!ctx.can(user, "telegram.manage")) return void response.status(403).json({ error: "recht_fehlt" });
    try {
      await sendTo(user, user.locale === "en" ? "<b>Matchdesk</b>: test message. Telegram works." : "<b>Matchdesk</b>: Testnachricht. Telegram funktioniert.");
      ctx.audit({ actor: user, action: "test_sent", summary: "Telegram-Testnachricht an das eigene Konto" });
      response.json({ ok: true });
    } catch (error) {
      response.status(502).json({ error: "telegram_fehlgeschlagen", detail: error instanceof Error ? error.message : String(error) });
    }
  });

  return { pollOnce, handleUpdate, state };
}

export function register(ctx: ModuleContext) {
  const bot = setup(ctx);
  const seconds = (ctx.settings.get() as TelegramSettings).pollSeconds ?? 3;
  if (ctx.env("TELEGRAM_BOT_TOKEN")) {
    ctx.schedule(seconds * 1000, bot.pollOnce);
    void bot.pollOnce();
  } else {
    ctx.log.warn("Telegram-Modul ohne Bot-Token: unter Admin › Module › Telegram › Zugangsdaten eintragen (oder MATCHDESK_TELEGRAM_BOT_TOKEN setzen)");
  }
}
