import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ModuleClientHost, ModulePageProps } from "@matchdesk/module-sdk";

type Kind = "game" | "date" | "food" | "other";
type Value = "yes" | "maybe" | "no";
type Option = {
  id: string;
  label: string;
  startsAt: string | null;
  suggested: boolean;
  yes: number;
  maybe: number;
  no: number;
  mine: Value | null;
  voters: Array<{ username: string; displayName: string | null; value: Value }>;
};
type Poll = {
  id: string;
  kind: Kind;
  title: string;
  description: string | null;
  mainEventId: string | null;
  mainEventName: string | null;
  multiple: boolean;
  allowSuggestions: boolean;
  anonymous: boolean;
  closesAt: string | null;
  open: boolean;
  canManage: boolean;
  canVote: boolean;
  voterCount: number;
  options: Option[];
};
type EventChoice = { id: string; name: string; manageable: boolean };
type EventsResponse = { canManageGlobal: boolean; events: EventChoice[] };

const KINDS: Kind[] = ["game", "date", "food", "other"];

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;
  const formatDate = (value: string) =>
    new Date(value).toLocaleString(host.locale, { weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

  function PollCard({ poll, onChange, onError }: { poll: Poll; onChange: (next?: Poll) => void; onError: (message: string) => void }) {
    const [draft, setDraft] = useState<Record<string, Value>>(() =>
      Object.fromEntries(poll.options.filter((option) => option.mine).map((option) => [option.id, option.mine as Value]))
    );
    const [suggestion, setSuggestion] = useState({ label: "", startsAt: "" });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
      setDraft(Object.fromEntries(poll.options.filter((option) => option.mine).map((option) => [option.id, option.mine as Value])));
    }, [poll]);

    async function run(action: () => Promise<Poll | undefined | void>) {
      setBusy(true);
      try {
        const next = await action();
        onChange(next ?? undefined);
      } catch (caught) {
        onError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    }

    const vote = () =>
      run(() =>
        api<Poll>(`/polls/${poll.id}/vote`, {
          method: "PUT",
          body: JSON.stringify({ votes: Object.entries(draft).map(([optionId, value]) => ({ optionId, value })) })
        })
      );

    function toggle(optionId: string) {
      if (poll.multiple) {
        const next = { ...draft };
        if (next[optionId]) delete next[optionId];
        else next[optionId] = "yes";
        setDraft(next);
      } else {
        setDraft(draft[optionId] ? {} : { [optionId]: "yes" });
      }
    }

    function suggest(event: FormEvent) {
      event.preventDefault();
      const startsAt = suggestion.startsAt ? new Date(suggestion.startsAt).toISOString() : null;
      const label = suggestion.label.trim() || (startsAt ? formatDate(startsAt) : "");
      void run(async () => {
        const next = await api<Poll>(`/polls/${poll.id}/options`, { method: "POST", body: JSON.stringify({ label, startsAt }) });
        setSuggestion({ label: "", startsAt: "" });
        return next;
      });
    }

    const max = Math.max(1, ...poll.options.map((option) => option.yes));
    const canAct = poll.open && poll.canVote;

    return (
      <article className="polls-card">
        <header>
          <h3>{poll.title}</h3>
          <p className="muted">
            {t(`kind.${poll.kind}`)}
            {poll.mainEventName ? ` · ${poll.mainEventName}` : ` · ${t("filter.global")}`}
            {" · "}
            {poll.open ? (poll.closesAt ? t("poll.closesAt", { date: formatDate(poll.closesAt) }) : t("poll.open")) : t("poll.closed")}
            {" · "}
            {t("poll.voters", { count: poll.voterCount })}
            {poll.anonymous ? ` · ${t("poll.anonymous")}` : ""}
          </p>
          {poll.description ? <p className="polls-description">{poll.description}</p> : null}
        </header>

        <ul className="polls-options">
          {poll.options.map((option) => (
            <li key={option.id} className="polls-option">
              <div className="polls-option-row">
                {poll.kind === "date" ? (
                  <span className="polls-option-label">
                    {option.label}
                    {option.startsAt ? <small className="muted"> {formatDate(option.startsAt)}</small> : null}
                  </span>
                ) : (
                  <label className="checkbox-row">
                    <input
                      type={poll.multiple ? "checkbox" : "radio"}
                      name={`poll-${poll.id}`}
                      checked={Boolean(draft[option.id])}
                      disabled={!canAct || busy}
                      onChange={() => toggle(option.id)}
                      onClick={() => {
                        if (!poll.multiple && draft[option.id]) toggle(option.id);
                      }}
                    />
                    {option.label}
                  </label>
                )}
                {option.suggested ? <small className="muted"> {t("option.suggested")}</small> : null}
                {poll.kind === "date" && canAct ? (
                  <span className="polls-date-buttons" role="group">
                    {(["yes", "maybe", "no"] as Value[]).map((value) => (
                      <button
                        key={value}
                        type="button"
                        className={draft[option.id] === value ? "" : "secondary"}
                        disabled={busy}
                        aria-pressed={draft[option.id] === value}
                        onClick={() => setDraft({ ...draft, [option.id]: value })}
                      >
                        {t(`value.${value}`)}
                      </button>
                    ))}
                  </span>
                ) : null}
                {poll.canManage ? (
                  <button
                    type="button"
                    className="secondary danger"
                    disabled={busy}
                    onClick={() => run(() => api<Poll>(`/polls/${poll.id}/options/${option.id}`, { method: "DELETE" }))}
                  >
                    {t("option.remove")}
                  </button>
                ) : null}
              </div>
              <div className="polls-result">
                <meter min={0} max={max} value={option.yes} aria-label={t("value.yes")} />
                <small>
                  {poll.kind === "date"
                    ? t("result.date", { yes: option.yes, maybe: option.maybe, no: option.no })
                    : t("result.choice", { count: option.yes })}
                </small>
              </div>
              {option.voters.length > 0 ? (
                <small className="muted">
                  {option.voters
                    .filter((voter) => poll.kind !== "date" || voter.value !== "no")
                    .map((voter) => `${voter.displayName || voter.username}${voter.value === "maybe" ? ` (${t("value.maybe")})` : ""}`)
                    .join(", ")}
                </small>
              ) : null}
            </li>
          ))}
        </ul>

        {canAct ? (
          <p>
            <button type="button" disabled={busy} onClick={vote}>
              {t("poll.vote")}
            </button>
          </p>
        ) : null}

        {poll.open && poll.allowSuggestions && (poll.canVote || poll.canManage) ? (
          <form className="admin-form inline-form" onSubmit={suggest}>
            <input
              value={suggestion.label}
              maxLength={120}
              placeholder={t("option.suggestPlaceholder")}
              onChange={(event) => setSuggestion({ ...suggestion, label: event.target.value })}
            />
            {poll.kind === "date" ? (
              <input
                type="datetime-local"
                required
                value={suggestion.startsAt}
                onChange={(event) => setSuggestion({ ...suggestion, startsAt: event.target.value })}
              />
            ) : null}
            <button type="submit" className="secondary" disabled={busy || (poll.kind === "date" ? !suggestion.startsAt : !suggestion.label.trim())}>
              {t("option.suggest")}
            </button>
          </form>
        ) : null}

        {poll.canManage ? (
          <p className="polls-manage">
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => run(() => api<Poll>(`/polls/${poll.id}`, { method: "PATCH", body: JSON.stringify({ closed: poll.open }) }))}
            >
              {poll.open ? t("poll.close") : t("poll.reopen")}
            </button>{" "}
            <button
              type="button"
              className="secondary danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t("poll.deleteConfirm"))) void run(() => api(`/polls/${poll.id}`, { method: "DELETE" }).then(() => undefined));
              }}
            >
              {t("poll.delete")}
            </button>
          </p>
        ) : null}
      </article>
    );
  }

  function CreatePoll({ events, onCreated, onError }: { events: EventsResponse; onCreated: () => void; onError: (message: string) => void }) {
    const targets = [
      ...(events.canManageGlobal ? [{ id: "", name: t("filter.global") }] : []),
      ...events.events.filter((event) => event.manageable)
    ];
    const [form, setForm] = useState({
      kind: "game" as Kind,
      title: "",
      description: "",
      target: targets[0]?.id ?? "",
      optionsText: "",
      dates: ["", ""],
      multiple: false,
      allowSuggestions: true,
      anonymous: false,
      closesAt: ""
    });
    const [busy, setBusy] = useState(false);
    if (targets.length === 0) return null;

    async function submit(event: FormEvent) {
      event.preventDefault();
      setBusy(true);
      try {
        const options =
          form.kind === "date"
            ? form.dates.filter(Boolean).map((value) => {
                const startsAt = new Date(value).toISOString();
                return { label: formatDate(startsAt), startsAt };
              })
            : form.optionsText
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .map((label) => ({ label }));
        await api("/polls", {
          method: "POST",
          body: JSON.stringify({
            kind: form.kind,
            title: form.title.trim(),
            description: form.description.trim() || null,
            mainEventId: form.target || null,
            multiple: form.multiple,
            allowSuggestions: form.allowSuggestions,
            anonymous: form.anonymous,
            closesAt: form.closesAt ? new Date(form.closesAt).toISOString() : null,
            options
          })
        });
        setForm({ ...form, title: "", description: "", optionsText: "", dates: ["", ""], closesAt: "" });
        onCreated();
      } catch (caught) {
        onError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    }

    return (
      <details className="polls-create">
        <summary>{t("create.toggle")}</summary>
        <form className="admin-form" onSubmit={submit}>
          <label>
            {t("create.kind")}
            <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as Kind })}>
              {KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("create.title")}
            <input required maxLength={160} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          <label>
            {t("create.description")}
            <textarea maxLength={2000} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </label>
          <label>
            {t("create.target")}
            <select value={form.target} onChange={(event) => setForm({ ...form, target: event.target.value })}>
              {targets.map((target) => (
                <option key={target.id || "global"} value={target.id}>
                  {target.name}
                </option>
              ))}
            </select>
          </label>
          {form.kind === "date" ? (
            <fieldset>
              <legend>{t("create.dates")}</legend>
              {form.dates.map((value, index) => (
                <input
                  key={index}
                  type="datetime-local"
                  value={value}
                  onChange={(event) => {
                    const dates = [...form.dates];
                    dates[index] = event.target.value;
                    if (index === dates.length - 1 && event.target.value) dates.push("");
                    setForm({ ...form, dates });
                  }}
                />
              ))}
            </fieldset>
          ) : (
            <label>
              {t("create.options")}
              <textarea
                rows={4}
                value={form.optionsText}
                placeholder={t(`create.optionsPlaceholder.${form.kind}`)}
                onChange={(event) => setForm({ ...form, optionsText: event.target.value })}
              />
            </label>
          )}
          {form.kind !== "date" ? (
            <label className="checkbox-row">
              <input type="checkbox" checked={form.multiple} onChange={(event) => setForm({ ...form, multiple: event.target.checked })} />
              {t("create.multiple")}
            </label>
          ) : null}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.allowSuggestions}
              onChange={(event) => setForm({ ...form, allowSuggestions: event.target.checked })}
            />
            {t("create.allowSuggestions")}
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={form.anonymous} onChange={(event) => setForm({ ...form, anonymous: event.target.checked })} />
            {t("create.anonymous")}
          </label>
          <label>
            {t("create.closesAt")}
            <input type="datetime-local" value={form.closesAt} onChange={(event) => setForm({ ...form, closesAt: event.target.value })} />
          </label>
          <button type="submit" disabled={busy || !form.title.trim()}>
            {t("create.submit")}
          </button>
        </form>
      </details>
    );
  }

  function Page(_props: ModulePageProps) {
    const [polls, setPolls] = useState<Poll[] | null>(null);
    const [events, setEvents] = useState<EventsResponse | null>(null);
    const [filter, setFilter] = useState("");
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
      const query = filter ? `?mainEventId=${encodeURIComponent(filter)}` : "";
      api<{ polls: Poll[] }>(`/polls${query}`)
        .then((result) => setPolls(result.polls))
        .catch((caught: Error) => setError(caught.message));
    }, [filter]);

    useEffect(() => {
      api<EventsResponse>("/events")
        .then(setEvents)
        .catch((caught: Error) => setError(caught.message));
    }, []);

    useEffect(() => {
      load();
      return host.onRealtime("polls_changed", load);
    }, [load]);

    function replace(next?: Poll) {
      if (next && polls) setPolls(polls.map((poll) => (poll.id === next.id ? next : poll)));
      else load();
    }

    const open = (polls ?? []).filter((poll) => poll.open);
    const closed = (polls ?? []).filter((poll) => !poll.open);

    return (
      <section className="polls-page">
        {error ? <p className="error">{error}</p> : null}
        {events ? (
          <label>
            {t("filter.label")}
            <select value={filter} onChange={(event) => setFilter(event.target.value)}>
              <option value="">{t("filter.all")}</option>
              <option value="global">{t("filter.global")}</option>
              {events.events.map((event) => (
                <option key={event.id} value={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {events ? <CreatePoll events={events} onCreated={load} onError={setError} /> : null}
        {!polls ? <p className="muted">…</p> : null}
        {polls && polls.length === 0 ? <p className="muted empty-state">{t("page.empty")}</p> : null}
        {open.map((poll) => (
          <PollCard key={poll.id} poll={poll} onChange={replace} onError={setError} />
        ))}
        {closed.length > 0 ? (
          <details>
            <summary>{t("page.closed", { count: closed.length })}</summary>
            {closed.map((poll) => (
              <PollCard key={poll.id} poll={poll} onChange={replace} onError={setError} />
            ))}
          </details>
        ) : null}
      </section>
    );
  }

  return { Page };
}
