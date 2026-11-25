import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import type { ModuleClientHost, ModuleClientUser, ModuleNoticeProps, ModulePageProps } from "@matchdesk/module-sdk";

type Localized = { de: string; en: string };
type Game = { id: string; name: Localized; description: Localized; embedPath: string; computerLevels: string[] };
type Side = { id: string | null; name: string | null; score: number };
type Match = {
  id: string;
  game: string;
  status: "open" | "finished" | "cancelled" | "expired";
  challenger: Side;
  opponent: Side;
  winner: { id: string; name: string | null } | null;
  gamesPlayed: number;
  updatedAt: string;
  mine: boolean;
  embedUrl: string | null;
};
type Player = { id: string; name: string; inEvent: boolean };

/** Nachricht des eingebetteten Spiels (siehe matchdesk-billiard, README „Einbindung“). */
type GameMessage = { source: "bandenduell"; type: "ready" | "status" | "matchEnded" | "closed"; status?: string; score?: [number, number] };

export default function createModule(host: ModuleClientHost) {
  const { t, api } = host;
  const base = `#games/${host.id}`;
  const lang = (text: Localized) => (host.locale.startsWith("en") ? text.en : text.de);

  function useGames() {
    const [games, setGames] = useState<Game[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
      api<{ games: Game[] }>("/games")
        .then((data) => setGames(data.games))
        .catch((caught: Error) => setError(caught.message));
    }, []);
    return { games, error };
  }

  function useMatches(game: string) {
    const [data, setData] = useState<{ mine: Match[]; recent: Match[] } | null>(null);
    const load = useCallback(() => {
      api<{ mine: Match[]; recent: Match[] }>(`/matches?game=${encodeURIComponent(game)}`)
        .then(setData)
        .catch(() => undefined);
    }, [game]);
    useEffect(() => {
      load();
      return host.onRealtime("matches_changed", load);
    }, [load]);
    return { data, reload: load };
  }

  function score(match: Match) {
    return `${match.challenger.name ?? "?"} ${match.challenger.score} : ${match.opponent.score} ${match.opponent.name ?? "?"}`;
  }

  // ---------- Spieleauswahl ----------

  /** Eigenes Billard-Zeichen: 8er-Kugel auf grünem Tuch mit Queue, Farben wie Bandenduell. */
  function BilliardLogo() {
    return (
      <svg className="arena-logo" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={t("logo.billiard")}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#1E6A4B" />
        <rect x="6" y="6" width="52" height="52" rx="11" fill="none" stroke="#2F8A63" strokeWidth="2" />
        <line x1="9" y1="55" x2="27" y2="38" stroke="#F2A93B" strokeWidth="4" strokeLinecap="round" />
        <line x1="9" y1="55" x2="14" y2="50" stroke="#7A4B1E" strokeWidth="4" strokeLinecap="round" />
        <circle cx="37" cy="28" r="16" fill="#15171A" />
        <circle cx="37" cy="28" r="7.5" fill="#FFFFFF" />
        <text x="37" y="31.6" textAnchor="middle" fontSize="10" fontWeight="700" fontFamily="system-ui, sans-serif" fill="#15171A">
          8
        </text>
        <ellipse cx="30" cy="20" rx="4" ry="2.4" fill="#FFFFFF" opacity="0.35" transform="rotate(-35 30 20)" />
      </svg>
    );
  }

  /** Dreierschub-Zeichen: vier Steine, einer wird von rechts eingeschoben. */
  function ShiftLogo() {
    return (
      <svg className="arena-logo" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label={t("logo.shift")}>
        <rect x="2" y="2" width="60" height="60" rx="14" fill="#13353A" />
        <rect x="10" y="12" width="17" height="17" rx="4" fill="#2BA6A0" />
        <rect x="30" y="12" width="17" height="17" rx="4" fill="#2BA6A0" />
        <rect x="10" y="33" width="17" height="17" rx="4" fill="#2BA6A0" />
        <rect x="30" y="33" width="17" height="17" rx="4" fill="#F0823C" />
        <path d="M57 41.5h-6m0 0 3-3m-3 3 3 3" stroke="#E9F0EE" strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    );
  }

  const LOGOS: Record<string, () => ReactElement> = { billiard: BilliardLogo, shift: ShiftLogo };

  function GamePicker() {
    const { games, error } = useGames();
    if (error) return <p className="error">{error}</p>;
    if (!games) return <p className="muted">…</p>;
    return (
      <section className="page-card arena-picker" aria-labelledby="arena-title">
        <h1 id="arena-title">{t("picker.title")}</h1>
        <p className="muted">{t("picker.hint")}</p>
        {games.length === 0 ? <p className="muted empty-state">{t("picker.empty")}</p> : null}
        <ul className="games-grid">
          {games.map((game) => (
            <li key={game.id}>
              <a className="games-tile" href={`${base}/${game.id}`}>
                {LOGOS[game.id] ? LOGOS[game.id]!() : null}
                <strong>{lang(game.name)}</strong>
                <span className="muted">{lang(game.description)}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // ---------- Lobby eines Spiels ----------

  function GameLobby({ gameId }: { gameId: string }) {
    const { games } = useGames();
    const game = games?.find((candidate) => candidate.id === gameId);
    const { data, reload } = useMatches(gameId);
    const [error, setError] = useState<string | null>(null);

    async function cancel(id: string) {
      await api(`/matches/${id}/cancel`, { method: "POST" }).catch((caught: Error) => setError(caught.message));
      reload();
    }

    if (games && !game) return <p className="error">{t("lobby.unknown")}</p>;
    const open = data?.mine.filter((m) => m.status === "open") ?? [];
    return (
      <section className="page-card arena-lobby" aria-labelledby="arena-lobby-title">
        <p>
          <a href={base}>‹ {t("nav.games")}</a>
        </p>
        <h1 id="arena-lobby-title">{game ? lang(game.name) : "…"}</h1>
        {error ? <p className="error">{error}</p> : null}
        <div className="action-row">
          <a className="button-link" href={`${base}/${gameId}/table`}>
            {t("lobby.openTable")}
          </a>
        </div>
        <p className="muted">{t("lobby.openTableHint")}</p>

        <h2>{t("lobby.open")}</h2>
        {open.length === 0 ? <p className="muted empty-state">{t("lobby.noOpen")}</p> : null}
        <ul className="device-list">
          {open.map((match) => (
            <li key={match.id} className="device-row">
              <div>
                <p className="item-title">{score(match)}</p>
                <p className="item-sub">{match.gamesPlayed > 0 ? t("lobby.played", { count: match.gamesPlayed }) : t("lobby.waiting")}</p>
              </div>
              <div className="device-actions">
                <a className="button-link" href={`${base}/${gameId}/match/${match.id}`}>
                  {t("lobby.toTable")}
                </a>
                <button type="button" className="secondary danger" onClick={() => cancel(match.id)}>
                  {t("lobby.cancel")}
                </button>
              </div>
            </li>
          ))}
        </ul>

        <h2>{t("lobby.recent")}</h2>
        {(data?.recent.length ?? 0) === 0 ? <p className="muted empty-state">{t("lobby.noRecent")}</p> : null}
        <ul className="device-list">
          {data?.recent.map((match) => (
            <li key={match.id} className="device-row">
              <div>
                <p className="item-title">{score(match)}</p>
                <p className="item-sub">
                  {match.winner?.name ? t("lobby.winner", { name: match.winner.name }) : ""} · {new Date(match.updatedAt).toLocaleString(host.locale)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  // ---------- Tisch öffnen: Mitspieler herausfordern oder gegen den Computer ----------

  function TableSetup({ gameId }: { gameId: string }) {
    const { games } = useGames();
    const game = games?.find((candidate) => candidate.id === gameId);
    const [players, setPlayers] = useState<Player[]>([]);
    const [opponentId, setOpponentId] = useState("");
    const [level, setLevel] = useState("medium");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
      api<{ players: Player[] }>("/players")
        .then((result) => setPlayers(result.players))
        .catch((caught: Error) => setError(caught.message));
    }, []);

    async function challenge(event: FormEvent) {
      event.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const result = await api<{ match: Match }>("/matches", { method: "POST", body: JSON.stringify({ game: gameId, opponentId }) });
        location.hash = `${base}/${gameId}/match/${result.match.id}`;
      } catch (caught) {
        setError((caught as Error).message);
      } finally {
        setBusy(false);
      }
    }

    function startComputer(event: FormEvent) {
      event.preventDefault();
      location.hash = `${base}/${gameId}/computer/${level}`;
    }

    if (games && !game) return <p className="error">{t("lobby.unknown")}</p>;
    const levels = game?.computerLevels ?? [];
    return (
      <section className="page-card arena-table" aria-labelledby="arena-table-title">
        <p>
          <a href={`${base}/${gameId}`}>‹ {game ? lang(game.name) : t("nav.games")}</a>
        </p>
        <h1 id="arena-table-title">{t("table.title")}</h1>
        {error ? <p className="error">{error}</p> : null}

        <h2>{t("table.player")}</h2>
        <form className="admin-form inline-form" onSubmit={challenge}>
          <label htmlFor="arena-opponent">{t("lobby.opponent")}</label>
          <select id="arena-opponent" value={opponentId} onChange={(event) => setOpponentId(event.target.value)}>
            <option value="">{t("lobby.choose")}</option>
            {players.map((player) => (
              <option key={player.id} value={player.id}>
                {player.name}
                {player.inEvent ? ` · ${t("lobby.inEvent")}` : ""}
              </option>
            ))}
          </select>
          <button type="submit" disabled={!opponentId || busy}>
            {t("lobby.challenge")}
          </button>
        </form>
        <p className="muted">{t("table.playerHint")}</p>

        {levels.length > 0 ? (
          <>
            <h2>{t("table.computer")}</h2>
            <form className="admin-form inline-form" onSubmit={startComputer}>
              <label htmlFor="arena-level">{t("table.level")}</label>
              <select id="arena-level" value={level} onChange={(event) => setLevel(event.target.value)}>
                {levels.map((id) => (
                  <option key={id} value={id}>
                    {t(`level.${id}`)}
                  </option>
                ))}
              </select>
              <button type="submit">{t("table.start")}</button>
            </form>
            <p className="muted">{t("table.computerHint")}</p>
          </>
        ) : null}
      </section>
    );
  }

  // ---------- Partie gegen den Computer (eingebettet, ohne Server) ----------

  function ComputerView({ gameId, level, user }: { gameId: string; level: string; user: ModuleClientUser }) {
    const { games, error } = useGames();
    const game = games?.find((candidate) => candidate.id === gameId);
    if (error) return <p className="error">{error}</p>;
    if (!games) return <p className="muted">…</p>;
    if (!game || !game.computerLevels.includes(level)) return <p className="error">{t("lobby.unknown")}</p>;
    const name = user.displayName || user.username;
    const src = `${game.embedPath}?embed=1&solo=${encodeURIComponent(level)}&name=${encodeURIComponent(name)}`;
    return (
      <section className="arena-match" aria-label={t("match.aria")}>
        <div className="arena-match-bar" style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center", marginBottom: 8 }}>
          <a href={`${base}/${gameId}/table`}>‹ {t("match.back")}</a>
          <strong>{t("computer.title", { level: t(`level.${level}`) })}</strong>
        </div>
        <GameFrame src={src} />
      </section>
    );
  }

  function GameFrame({ src }: { src: string }) {
    return (
      <iframe
        title={t("match.aria")}
        src={src}
        allow="fullscreen"
        style={{
          display: "block",
          width: "100%",
          height: "calc(100dvh - 170px)",
          minHeight: 420,
          border: 0,
          borderRadius: 12,
          background: "#0f1a1d"
        }}
      />
    );
  }

  // ---------- Partie (eingebettet) ----------

  function MatchView({ gameId, matchId }: { gameId: string; matchId: string }) {
    const [match, setMatch] = useState<Match | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [live, setLive] = useState<GameMessage | null>(null);

    const load = useCallback(() => {
      api<{ match: Match }>(`/matches/${matchId}`)
        .then((result) => setMatch(result.match))
        .catch((caught: Error) => setError(caught.message));
    }, [matchId]);

    useEffect(() => {
      load();
      const off = host.onRealtime("matches_changed", (data) => {
        if ((data as { id?: string } | undefined)?.id === matchId) load();
      });
      const onMessage = (event: MessageEvent) => {
        if (event.origin !== location.origin) return;
        const data = event.data as GameMessage | undefined;
        if (data?.source !== "bandenduell") return;
        setLive(data);
        if (data.type === "matchEnded" || data.type === "closed") load();
      };
      window.addEventListener("message", onMessage);
      return () => {
        off();
        window.removeEventListener("message", onMessage);
      };
    }, [load, matchId]);

    if (error) return <p className="error">{error}</p>;
    if (!match) return <p className="muted">…</p>;
    const header = (
      <div className="arena-match-bar" style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center", marginBottom: 8 }}>
        <a href={`${base}/${gameId}`}>‹ {t("match.back")}</a>
        <strong>{score(match)}</strong>
        {match.status === "finished" && match.winner?.name ? <span className="badge badge--ok">{t("lobby.winner", { name: match.winner.name })}</span> : null}
        {live?.type === "matchEnded" ? <span className="muted">{t("match.ended")}</span> : null}
      </div>
    );
    if (!match.embedUrl) {
      return (
        <section className="page-card">
          {header}
          <p className="muted">{match.mine ? t("match.closed") : t("match.notYours")}</p>
        </section>
      );
    }
    return (
      <section className="arena-match" aria-label={t("match.aria")}>
        {header}
        <GameFrame src={match.embedUrl} />
      </section>
    );
  }

  function Page({ subPath, user }: ModulePageProps) {
    const parts = subPath.split("/").filter(Boolean);
    if (parts.length === 0) return <GamePicker />;
    if (parts[1] === "match" && parts[2]) return <MatchView key={parts[2]} gameId={parts[0]!} matchId={parts[2]} />;
    if (parts[1] === "table") return <TableSetup key={parts[0]} gameId={parts[0]!} />;
    if (parts[1] === "computer" && parts[2]) return <ComputerView key={parts[2]} gameId={parts[0]!} level={parts[2]} user={user} />;
    return <GameLobby key={parts[0]} gameId={parts[0]!} />;
  }

  /** Hinweis auf der Startseite: offene Herausforderungen an mich. */
  function Notice({ user }: ModuleNoticeProps) {
    const [open, setOpen] = useState<Match[]>([]);
    useEffect(() => {
      const load = () =>
        api<{ mine: Match[] }>("/matches")
          .then((data) => setOpen(data.mine.filter((m) => m.status === "open" && m.opponent.id === user.id && m.gamesPlayed === 0)))
          .catch(() => setOpen([]));
      load();
      return host.onRealtime("matches_changed", load);
    }, [user.id]);
    if (open.length === 0) return null;
    return (
      <div className="notice">
        {open.map((match) => (
          <p key={match.id}>
            {t("notice.challenge", { name: match.challenger.name ?? "?" })}{" "}
            <a href={`${base}/${match.game}/match/${match.id}`}>{t("lobby.toTable")}</a>
          </p>
        ))}
      </div>
    );
  }

  return { Page, Notice };
}
