import { useCallback, useEffect, useState } from "react";
import type { ModuleAdminProps, ModuleClientHost } from "@matchdesk/module-sdk";

type Status = {
  configured: boolean;
  sentToday: number;
  dailyLimit: number;
  ownNumber: string | null;
  recent: Array<{ id: string; kind: string; status: string; error: string | null; createdAt: string; username: string | null }>;
};

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;

  function Admin(_props: ModuleAdminProps) {
    const [status, setStatus] = useState<Status | null>(null);
    const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(() => {
      api<Status>("/admin/status")
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
        load();
      }
    }

    if (!status) return <p className="muted">{note?.text ?? "…"}</p>;
    return (
      <div className="sms-admin">
        <p>{status.configured ? t("admin.configured") : t("admin.notConfigured")}</p>
        <p>{t("admin.today", { sent: status.sentToday, limit: status.dailyLimit })}</p>
        <p className="muted">{t("admin.cost")}</p>
        {status.ownNumber ? (
          <p>
            <button type="button" disabled={busy || !status.configured} onClick={sendTest}>
              {t("admin.test")}
            </button>{" "}
            <span className="muted">{t("admin.testTo", { number: status.ownNumber })}</span>
          </p>
        ) : (
          <p className="muted">{t("admin.noNumber")}</p>
        )}
        {note ? <p className={note.error ? "error" : "muted"}>{note.text}</p> : null}
        <h3>{t("admin.recent")}</h3>
        {status.recent.length === 0 ? <p className="muted">{t("admin.empty")}</p> : null}
        <ul className="device-list">
          {status.recent.map((entry) => (
            <li key={entry.id} className="device-row">
              <div>
                <p>
                  {t(`admin.kind.${entry.kind}`)} · {entry.username ?? "–"} · {t(`admin.status.${entry.status}`)}
                </p>
                <small className="muted">
                  {new Date(entry.createdAt).toLocaleString(host.locale)}
                  {entry.error ? ` · ${entry.error}` : ""}
                </small>
              </div>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return { Admin };
}
