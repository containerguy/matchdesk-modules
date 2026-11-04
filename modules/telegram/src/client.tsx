import { useCallback, useEffect, useState } from "react";
import type { ModuleAdminProps, ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";

type Me = {
  configured: boolean;
  botUsername: string | null;
  linked: boolean;
  blocked: boolean;
  telegramUsername: string | null;
  linkedAt: string | null;
};

type AdminStatus = {
  configured: boolean;
  botUsername: string | null;
  linked: number;
  blocked: number;
  ownLinked: boolean;
  lastPollAt: string | null;
  error: string | null;
};

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;

  function Page(_props: ModulePageProps) {
    const [me, setMe] = useState<Me | null>(null);
    const [linkUrl, setLinkUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
      api<Me>("/me")
        .then((next) => {
          setMe(next);
          if (next.linked) setLinkUrl(null);
        })
        .catch((caught: Error) => setError(caught.message));
    }, []);

    useEffect(() => {
      load();
      return host.onRealtime("link_changed", load);
    }, [load]);

    async function link() {
      setBusy(true);
      setError(null);
      try {
        const result = await api<{ url: string }>("/link", { method: "POST", body: "{}" });
        setLinkUrl(result.url);
        window.open(result.url, "_blank", "noopener");
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    }

    async function unlink() {
      setBusy(true);
      try {
        await api("/link", { method: "DELETE" });
        load();
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    }

    if (!me) return <p className="muted">{error ?? "…"}</p>;
    return (
      <section className="telegram-page">
        <h2>{t("page.title")}</h2>
        {error ? <p className="error">{error}</p> : null}
        {!me.configured ? <p className="muted">{t("page.notConfigured")}</p> : null}
        {me.configured && me.linked && !me.blocked ? (
          <>
            <p>{me.telegramUsername ? t("page.linkedAs", { name: `@${me.telegramUsername}` }) : t("page.linked")}</p>
            <p className="muted">{t("page.turnOn")}</p>
            <button type="button" className="secondary danger" disabled={busy} onClick={unlink}>
              {t("page.unlink")}
            </button>
          </>
        ) : null}
        {me.configured && (!me.linked || me.blocked) ? (
          <>
            <p>{me.blocked ? t("page.blocked") : t("page.intro", { bot: me.botUsername ? `@${me.botUsername}` : "Bot" })}</p>
            <button type="button" disabled={busy || !me.botUsername} onClick={link}>
              {t("page.link")}
            </button>
            {linkUrl ? (
              <p className="muted">
                {t("page.waiting")}{" "}
                <a href={linkUrl} target="_blank" rel="noreferrer">
                  {t("page.openAgain")}
                </a>
              </p>
            ) : null}
          </>
        ) : null}
      </section>
    );
  }

  function Admin(_props: ModuleAdminProps) {
    const [status, setStatus] = useState<AdminStatus | null>(null);
    const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
      api<AdminStatus>("/admin/status")
        .then(setStatus)
        .catch((caught: Error) => setNote({ text: caught.message, error: true }));
    }, []);
    useEffect(load, [load]);

    async function sendTest() {
      setBusy(true);
      setNote(null);
      try {
        await api("/admin/test", { method: "POST", body: "{}" });
        setNote({ text: t("admin.testOk"), error: false });
      } catch (caught) {
        setNote({ text: (caught as Error).message, error: true });
      } finally {
        setBusy(false);
      }
    }

    if (!status) return <p className="muted">{note?.text ?? "…"}</p>;
    return (
      <div className="telegram-admin">
        <p>
          {status.configured
            ? t("admin.configured", { bot: status.botUsername ? `@${status.botUsername}` : "?" })
            : t("admin.notConfigured")}
        </p>
        {status.error ? <p className="error">{status.error}</p> : null}
        <p>{t("admin.linked", { linked: status.linked, blocked: status.blocked })}</p>
        {status.ownLinked ? (
          <button type="button" disabled={busy} onClick={sendTest}>
            {t("admin.test")}
          </button>
        ) : (
          <p className="muted">{t("admin.linkFirst")}</p>
        )}
        {note ? <p className={note.error ? "error" : "muted"}>{note.text}</p> : null}
      </div>
    );
  }

  return { Page, Admin };
}
