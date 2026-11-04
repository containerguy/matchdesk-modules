import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ModuleAdminProps, ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";

type Note = { id: string; text: string; createdAt: string; author: string | null };
type NotesResponse = { greeting: string; canPost: boolean; canManage: boolean; notes: Note[] };

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;

  function Page(_props: ModulePageProps) {
    const [data, setData] = useState<NotesResponse | null>(null);
    const [text, setText] = useState("");
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
      api<NotesResponse>("/notes")
        .then(setData)
        .catch((caught: Error) => setError(caught.message));
    }, []);

    useEffect(() => {
      load();
      return host.onRealtime("notes_changed", load);
    }, [load]);

    async function post(event: FormEvent) {
      event.preventDefault();
      setError(null);
      try {
        await api("/notes", { method: "POST", body: JSON.stringify({ text }) });
        setText("");
        load();
      } catch (caught) {
        setError((caught as Error).message);
      }
    }

    async function remove(id: string) {
      await api(`/notes/${id}`, { method: "DELETE" }).catch((caught: Error) => setError(caught.message));
      load();
    }

    if (!data) return <p className="muted">{error ?? "…"}</p>;
    return (
      <section className="hallo-page">
        <h2>{data.greeting}</h2>
        {error ? <p className="error">{error}</p> : null}
        {data.canPost ? (
          <form className="admin-form inline-form" onSubmit={post}>
            <input value={text} maxLength={500} placeholder={t("page.placeholder")} onChange={(event) => setText(event.target.value)} />
            <button type="submit" disabled={!text.trim()}>
              {t("page.post")}
            </button>
          </form>
        ) : null}
        <h3>{t("page.title")}</h3>
        {data.notes.length === 0 ? <p className="muted">{t("page.empty")}</p> : null}
        <ul className="device-list">
          {data.notes.map((note) => (
            <li key={note.id} className="device-row">
              <div>
                <p>{note.text}</p>
                <small className="muted">
                  {note.author ? t("page.by", { name: note.author }) : ""} · {new Date(note.createdAt).toLocaleString(host.locale)}
                </small>
              </div>
              {data.canManage || note.author === _props.user.username ? (
                <button type="button" className="secondary danger" onClick={() => remove(note.id)}>
                  {t("page.delete")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  function Admin(_props: ModuleAdminProps) {
    const [count, setCount] = useState<number | null>(null);
    const load = useCallback(() => {
      api<{ count: number }>("/admin/stats").then((result) => setCount(result.count));
    }, []);
    useEffect(load, [load]);
    return (
      <div className="hallo-admin">
        <p>{t("admin.info", { count: count ?? "…" })}</p>
        <button
          type="button"
          className="secondary danger"
          onClick={() => {
            if (window.confirm(t("admin.clear"))) void api("/admin/notes", { method: "DELETE" }).then(load);
          }}
        >
          {t("admin.clear")}
        </button>
      </div>
    );
  }

  return { Page, Admin };
}
