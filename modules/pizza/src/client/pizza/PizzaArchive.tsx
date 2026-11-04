import { useEffect, useState } from "react";
import { getErrorMessage } from "../errors/errors";
import { useI18n } from "../i18n/I18nContext";
import { deleteArchivedPizzaSession, fetchArchivedPizzaSessions } from "./api";
import { formatEuro } from "./price";
import type { PizzaArchivedSession } from "./types";

/** Liste archivierter Bestellrunden (ab manager) mit Kassenliste und endgültigem Löschen. */
export function PizzaArchive() {
  const { t, locale } = useI18n();
  const [sessions, setSessions] = useState<PizzaArchivedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setSessions(await fetchArchivedPizzaSessions());
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err, locale));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dateFormat = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "de-DE", {
    dateStyle: "medium",
    timeStyle: "short"
  });

  function titleFor(session: PizzaArchivedSession) {
    const date = dateFormat.format(new Date(session.openedAt ?? session.createdAt));
    const event = session.mainEventName ? ` · ${session.mainEventName}` : "";
    return `${session.label ?? t("pizza.archive.untitled")}${event} · ${date}`;
  }

  async function remove(session: PizzaArchivedSession) {
    if (!window.confirm(t("pizza.archive.deleteConfirm", { label: titleFor(session) }))) return;
    try {
      await deleteArchivedPizzaSession(session.id);
      await load();
    } catch (err) {
      setError(getErrorMessage(err, locale));
    }
  }

  return (
    <section className="pizza-archive" aria-label={t("pizza.archive.title")}>
      <h4>{t("pizza.archive.title")}</h4>
      {error ? (
        <p className="pizza-panel__error" role="alert">
          {error}
        </p>
      ) : null}
      {sessions === null && !error ? <p className="muted">{t("pizza.archive.loading")}</p> : null}
      {sessions && sessions.length === 0 ? <p className="muted">{t("pizza.archive.empty")}</p> : null}
      {sessions && sessions.length > 0 ? (
        <ul className="pizza-archive__list">
          {sessions.map((session) => (
            <li key={session.id} className="pizza-archive__row">
              <div className="pizza-archive__info">
                <strong>{titleFor(session)}</strong>
                <span className="muted">
                  {t("pizza.archive.summary", {
                    orders: session.orderCount,
                    total: formatEuro(session.totalCents),
                    unpaid: session.unpaidCount
                  })}
                  {" · "}
                  {t("pizza.archive.archivedAt", {
                    at: dateFormat.format(new Date(session.archivedAt))
                  })}
                </span>
              </div>
              <div className="pizza-archive__actions">
                <a
                  className="secondary pizza-panel__pdf-link"
                  href={`/api/m/pizza/print/kassenliste.pdf?sessionId=${encodeURIComponent(session.id)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("pizza.archive.pdf")}
                </a>
                <button type="button" className="secondary danger" onClick={() => void remove(session)}>
                  {t("pizza.archive.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
