import { useState, useEffect, useRef } from "react";
import Reactions from "../../components/Reactions";
import { useRoom } from "../../utils/useRoom";
import { shareUrl, clientId } from "../../utils/room";
import { RANKS } from "./engine";

const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };

export default function LitApp({ code, onLeave }) {
  const me = clientId();
  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } = useRoom(code, { game: "lit", clientId: me });

  const phase = view?.phase || "lobby"; // "lobby" | "playing"
  const seated = !!view?.players?.find((p) => p.id === me);
  const [name, setName] = useState("");

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = shareUrl(code, "lit");
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const handleJoin = () => {
    const n = name.trim();
    if (!n) return;
    sendAction({ type: "join", name: n });
  };

  const handleStart = () => sendAction({ type: "start" });
  const handleAsk = (toId, rank) => sendAction({ type: "ask", toId, rank });
  const handleDeclare = (rank) => sendAction({ type: "declare", rank });
  const handleReset = () => {
    if (!window.confirm("Reset the game?")) return;
    sendAction({ type: "reset" });
  };

  const started = phase === "playing" && !!view?.you;
  const myTurn = started && view.turn === me;

  // Re-bind this WS to our clientId after a refresh/reconnect.
  const rejoinedRef = useRef(false);
  useEffect(() => {
    if (!connected) { rejoinedRef.current = false; return; }
    if (rejoinedRef.current) return;
    const known = view?.players?.find((p) => p.id === me);
    if (known?.name) {
      rejoinedRef.current = true;
      sendAction({ type: "join", name: known.name });
    }
  }, [connected, view, me, sendAction]);

  // ── Floating "set made" alert ──────────────────────────────
  // Pops a minimalistic toast whenever anyone completes or declares a set.
  // Detection is the React "adjust state during render" pattern: lastSeenSig
  // holds the signature of the most recent set we've reacted to. We baseline it
  // on the first real view (so joining mid-game never replays history), then
  // alert once per genuinely new set. `undefined` = not yet baselined.
  const [setAlert, setSetAlert] = useState(null);
  const [lastSeenSig, setLastSeenSig] = useState(undefined);

  const latestSet = findLatestSet(view?.log);
  const setSig = latestSet
    ? `${latestSet.t || 0}:${latestSet.kind}:${latestSet.rank}:${latestSet.by}`
    : null;
  if (view && lastSeenSig === undefined) {
    setLastSeenSig(setSig); // first real view → baseline, no alert
  } else if (view && setSig && setSig !== lastSeenSig) {
    setLastSeenSig(setSig);
    setSetAlert({
      key: setSig,
      who: latestSet.by === me
        ? "You"
        : (view?.players?.find((p) => p.id === latestSet.by)?.name ?? "Someone"),
      rank: latestSet.rank,
      team: latestSet.team || null,
      declared: latestSet.kind === "declare_hit",
    });
  }

  useEffect(() => {
    if (!setAlert) return;
    const id = setTimeout(() => setSetAlert(null), 2600);
    return () => clearTimeout(id);
  }, [setAlert]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          LIT<span className="slash">/</span>FOUR-OF-A-KIND
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {started && (
            <button className="room" onClick={handleReset} title="Reset this game">
              RESET
            </button>
          )}
          {presence > 0 && (
            <span className="presence">
              <span className="dot" />
              {presence} watching
            </span>
          )}
          <button
            className={"room " + (copied ? "copied" : "")}
            onClick={copyLink}
            title="Copy share link"
          >
            {copied ? "LINK COPIED" : code}
          </button>
        </div>
      </header>

      {!connected && <div className="conn-state">RECONNECTING…</div>}

      {error && (
        <div className="error-toast" role="alert" onClick={dismissError}>
          <span className="error-toast-msg">{error.message}</span>
          <button className="error-toast-x" aria-label="Dismiss">×</button>
        </div>
      )}

      {setAlert && (
        <div className="set-alert" role="status" key={setAlert.key}>
          <span className="set-alert-rank">{setAlert.rank}</span>
          <span className="set-alert-text">
            {setAlert.who} {setAlert.declared ? "declared the set" : "completed a set"}
            {setAlert.team ? <> · <strong>TEAM {setAlert.team}</strong></> : null}
          </span>
        </div>
      )}

      <main>
        {phase === "lobby" && (
          <Lobby
            name={name}
            setName={setName}
            onJoin={handleJoin}
            onStart={handleStart}
            onSetMode={(m) => sendAction({ type: "setMode", mode: m })}
            onSwapTeam={(pid) => sendAction({ type: "swapTeam", targetClientId: pid })}
            view={view}
            me={me}
            joined={seated}
          />
        )}

        {started && (
          <Table
            view={view}
            myTurn={myTurn}
            onAsk={handleAsk}
            onDeclare={handleDeclare}
            onPlayAgain={() => sendAction({ type: "reset" })}
            me={me}
          />
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ───────────────────────────────────────────────────────────
function Lobby({ name, setName, onJoin, joined, onStart, onSetMode, onSwapTeam, view, me }) {
  const players = view?.players || [];
  const mode = view?.mode || "solo";
  const teams = view?.teams || null;
  const canTeam = players.length === 4 || players.length === 6;

  // In team mode, DEAL needs equal-size teams totaling 4 or 6.
  const teamReady =
    mode === "team" &&
    teams &&
    teams.length === 2 &&
    teams[0].playerIds.length === teams[1].playerIds.length &&
    (players.length === 4 || players.length === 6);

  const dealEnabled =
    mode === "solo" ? players.length >= 2 : teamReady;

  return (
    <div className="setup">
      <h2>LOBBY</h2>
      {!joined && (
        <div className="setup-row">
          <input
            className="text-input"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onJoin()}
          />
          <button className="start-btn" onClick={onJoin} disabled={!name.trim()}>
            JOIN →
          </button>
        </div>
      )}

      {joined && players.length >= 2 && (
        <div className="mode-toggle">
          <button
            className={"mode-btn" + (mode === "solo" ? " active" : "")}
            onClick={() => onSetMode("solo")}
          >
            SOLO
          </button>
          <button
            className={"mode-btn" + (mode === "team" ? " active" : "")}
            disabled={!canTeam}
            title={canTeam ? "" : "Team mode needs 4 or 6 players"}
            onClick={() => onSetMode("team")}
          >
            TEAM
          </button>
        </div>
      )}

      {mode === "solo" || !teams ? (
        <div className="seated-list">
          <div className="seated-title">SEATED</div>
          {players.length === 0 && <div className="muted">No one yet.</div>}
          {players.map((p) => (
            <div key={p.id || p.name} className="seated-row">
              <span>{p.name || "—"}</span>
              {p.id === me && <span className="muted"> (you)</span>}
            </div>
          ))}
        </div>
      ) : (
        <TeamColumns
          players={players}
          teams={teams}
          me={me}
          onSwap={onSwapTeam}
          locked={!joined}
        />
      )}

      {joined && (
        <button
          className="start-btn deal-btn"
          onClick={onStart}
          disabled={!dealEnabled}
        >
          DEAL →
        </button>
      )}
      {joined && mode === "solo" && players.length < 2 && (
        <div className="muted">Need at least 2 players.</div>
      )}
      {joined && mode === "team" && !teamReady && (
        <div className="muted">
          Team mode needs 4 or 6 players with equal teams.
        </div>
      )}
    </div>
  );
}

function TeamColumns({ players, teams, me, onSwap, locked }) {
  const byId = new Map(players.map((p) => [p.id, p]));
  return (
    <div className="team-cols">
      {teams.map((t) => (
        <div key={t.id} className={"team-col team-" + t.id}>
          <div className="team-col-title">TEAM {t.id}</div>
          {t.playerIds.length === 0 && (
            <div className="muted small">empty</div>
          )}
          {t.playerIds.map((pid) => {
            const p = byId.get(pid);
            if (!p) return null;
            return (
              <button
                key={pid}
                className={"team-player" + (pid === me ? " is-me" : "")}
                disabled={locked}
                title={locked ? "" : "Tap to flip to the other team"}
                onClick={() => onSwap(pid)}
              >
                <span>{p.name || "—"}</span>
                {pid === me && <span className="muted"> (you)</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── TABLE (in-game) ────────────────────────────────────────────────
function Table({ view, myTurn, onAsk, onDeclare, onPlayAgain, me }) {
  const { you, opponents, teammates = [], deckCount, winner, players, mode } = view;
  const myRanks = Array.from(new Set(you.hand.map((c) => c[0])));

  const [askTarget, setAskTarget] = useState(null);
  const [declareOpen, setDeclareOpen] = useState(false);

  if (winner) {
    return <WinnerBanner view={view} me={me} onPlayAgain={onPlayAgain} />;
  }

  const isTeam = mode === "team";
  const claimedRanks = isTeam
    ? new Set([...(view.teamSets?.A || []), ...(view.teamSets?.B || [])])
    : new Set();

  // Card count per player id, for the turn strip at the top.
  const handCountById = new Map([[me, you.hand.length]]);
  opponents.forEach((o) => handCountById.set(o.id, o.handCount));
  teammates.forEach((t) => handCountById.set(t.id, t.handCount));

  return (
    <div className="set-table">
      <PlayersStrip
        players={players}
        turn={view.turn}
        me={me}
        handCountById={handCountById}
      />

      {isTeam && (
        <TeamScoreboard
          view={view}
          me={me}
        />
      )}

      <div className="set-status">
        {myTurn ? (
          <strong>
            YOUR TURN{isTeam ? " — ask an opponent or declare a set" : " — pick an opponent then a card you hold"}
          </strong>
        ) : (
          <span>Waiting on {nameOf(players, view.turn)}…</span>
        )}
        <span className="muted"> · Deck: {deckCount}</span>
      </div>

      {isTeam && teammates.length > 0 && (
        <div className="teammates">
          <div className="team-strip-label">YOUR TEAM</div>
          <div className="teammate-row">
            {teammates.map((m) => (
              <div key={m.id} className="teammate">
                <div className="teammate-name">{m.name}</div>
                <div className="teammate-meta">{m.handCount} cards</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className={"opponents" + (isTeam ? " team-strip" : "")}>
        {isTeam && <div className="team-strip-label">OPPONENTS</div>}
        <div className="opponent-row">
          {opponents.map((o) => (
            <button
              key={o.id}
              className={"opponent" + (askTarget === o.id ? " selected" : "")}
              disabled={!myTurn || winner}
              onClick={() => setAskTarget(o.id)}
            >
              <div className="opponent-name">{o.name}</div>
              <div className="opponent-meta">
                {o.handCount} cards
                {!isTeam && <> · {o.sets} sets</>}
                {view.turn === o.id && <span> · turn</span>}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="your-area">
        <div className="your-meta">
          YOU · {you.hand.length} cards
          {!isTeam && <> · {you.sets.length} sets</>}
        </div>
        <div className="your-hand">
          {you.hand
            .slice()
            .sort(sortCards)
            .map((c) => (
              <PlayingCard
                key={c}
                card={c}
                askable={myTurn && !winner}
                selected={myTurn && askTarget && myRanks.includes(c[0])}
                onClick={() => {
                  if (!myTurn || !askTarget || winner) return;
                  onAsk(askTarget, c[0]);
                  setAskTarget(null);
                }}
              />
            ))}
        </div>

        {myTurn && !askTarget && !winner && (
          <div className="muted ask-hint">
            Pick an opponent above, then tap one of your cards
            {isTeam && " — or declare a set if you think your team holds all 4 of a rank"}.
          </div>
        )}
        {myTurn && askTarget && !winner && (
          <div className="ask-hint">
            <strong>Asking {nameOf(players, askTarget)}</strong>
            <span className="muted"> — tap a card whose rank you want.</span>
          </div>
        )}

        {isTeam && myTurn && !winner && (
          <div className="declare-bar">
            <button
              className="start-btn declare-btn"
              onClick={() => setDeclareOpen(true)}
            >
              DECLARE A SET →
            </button>
          </div>
        )}
      </div>

      <ActivityLog log={view.log} players={players} me={me} />

      {declareOpen && (
        <DeclareModal
          claimedRanks={claimedRanks}
          onCancel={() => setDeclareOpen(false)}
          onConfirm={(rank) => {
            setDeclareOpen(false);
            onDeclare(rank);
          }}
        />
      )}
    </div>
  );
}

// At-a-glance turn order: everyone (including you) is listed; the player whose
// turn it is shows in white, the rest greyed. When it's YOUR turn, you turn
// pink so attention lands on you.
function PlayersStrip({ players, turn, me, handCountById }) {
  return (
    <div className="players-strip" aria-label="Players">
      {players.map((p) => {
        const isTurn = p.id === turn;
        const isMe = p.id === me;
        const cls =
          "player-pip" +
          (isTurn ? " is-turn" : "") +
          (isTurn && isMe ? " is-mine-turn" : "");
        return (
          <div key={p.id} className={cls}>
            {isTurn && <span className="player-pip-dot" aria-hidden="true" />}
            <span className="player-pip-name">
              {p.name}
              {isMe && <span className="player-pip-you"> (you)</span>}
            </span>
            <span className="player-pip-cards">{handCountById.get(p.id) ?? 0}</span>
          </div>
        );
      })}
    </div>
  );
}

function TeamScoreboard({ view, me }) {
  const { teams, teamSets, players, yourTeam } = view;
  return (
    <div className="team-score">
      {teams.map((t) => {
        const sets = teamSets?.[t.id] || [];
        const isMine = t.id === yourTeam;
        return (
          <div
            key={t.id}
            className={
              "team-score-block team-" + t.id + (isMine ? " is-mine" : "")
            }
          >
            <div className="team-score-head">
              TEAM {t.id}{isMine && <span className="muted"> (you)</span>}
            </div>
            <div className="team-score-num">{sets.length}</div>
            <div className="team-score-sub">
              {sets.length === 0
                ? "no sets yet"
                : sets.join(" · ")}
            </div>
            <div className="team-score-roster">
              {t.playerIds.map((pid) => (
                <span
                  key={pid}
                  className={"roster-name" + (pid === me ? " is-me" : "")}
                >
                  {nameOf(players, pid)}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeclareModal({ claimedRanks, onCancel, onConfirm }) {
  const [picked, setPicked] = useState(null);
  return (
    <div className="declare-modal-backdrop" onClick={onCancel}>
      <div className="declare-modal" onClick={(e) => e.stopPropagation()}>
        <div className="declare-title">DECLARE A SET</div>
        <div className="declare-body muted">
          Pick a rank. Your team must collectively hold all four cards. If
          you're wrong, the set goes to the opposing team and your turn ends.
        </div>
        <div className="declare-ranks">
          {RANKS.map((r) => {
            const taken = claimedRanks.has(r);
            return (
              <button
                key={r}
                className={
                  "declare-rank" +
                  (taken ? " taken" : "") +
                  (picked === r ? " picked" : "")
                }
                disabled={taken}
                onClick={() => setPicked(r)}
              >
                {r}
              </button>
            );
          })}
        </div>
        <div className="declare-actions">
          <button className="room" onClick={onCancel}>CANCEL</button>
          <button
            className="start-btn"
            disabled={!picked}
            onClick={() => onConfirm(picked)}
          >
            DECLARE {picked || ""} →
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityLog({ log, players, me }) {
  if (!log || log.length === 0) return null;
  const who = (id) => (id === me ? "You" : nameOf(players, id));
  const verb = (id, youForm, otherForm) => (id === me ? youForm : otherForm);

  const visible = log.filter(
    (e) => e.kind !== "start" && e.kind !== "auto_draw"
  );
  const latest = visible[visible.length - 1];
  const rows = (latest ? [latest] : [])
    .map((e, i) => {
      let line = null;
      let cls = "log-row";
      switch (e.kind) {
        case "ask_hit":
          line = (
            <>
              <strong>{who(e.from)}</strong> asked <strong>{who(e.to)}</strong> for{" "}
              <span className="log-rank">{e.rank}</span> — got{" "}
              <strong>{e.count}</strong> card{e.count === 1 ? "" : "s"}
              {", keeps turn"}
            </>
          );
          cls += " log-hit";
          break;
        case "ask_miss":
        case "ask_miss_lucky":
        case "ask_miss_no_deck": {
          const drawSuffix =
            e.kind === "ask_miss_no_deck"
              ? "no deck left, turn passes"
              : e.kind === "ask_miss_lucky"
                ? `drew ${e.drawn || `the ${e.rank}`} from deck, keeps turn`
                : e.drawn
                  ? `${verb(e.from, "you", "they")} drew ${e.drawn} from deck, turn passes`
                  : "drew from deck, turn passes";
          line = (
            <>
              <strong>{who(e.from)}</strong> asked <strong>{who(e.to)}</strong> for{" "}
              <span className="log-rank">{e.rank}</span> — miss, {drawSuffix}
            </>
          );
          cls += " log-miss";
          break;
        }
        case "set_collected":
          line = (
            <>
              <strong>{who(e.by)}</strong> completed set{" "}
              <span className="log-rank">{e.rank}</span>
              {e.team ? <> for <strong>TEAM {e.team}</strong></> : null}
            </>
          );
          cls += " log-set";
          break;
        case "declare_hit":
          line = (
            <>
              <strong>{who(e.by)}</strong> declared{" "}
              <span className="log-rank">{e.rank}</span> —{" "}
              <strong>TEAM {e.team}</strong> wins the set
            </>
          );
          cls += " log-set";
          break;
        case "declare_miss":
          line = (
            <>
              <strong>{who(e.by)}</strong> declared{" "}
              <span className="log-rank">{e.rank}</span> — missed,{" "}
              <strong>TEAM {e.awardedTo}</strong> takes it
            </>
          );
          cls += " log-miss";
          break;
        default:
          return null;
      }
      return (
        <li key={(e.t || 0) + ":" + i} className={cls}>
          {line}
        </li>
      );
    })
    .filter(Boolean);

  if (rows.length === 0) return null;

  return (
    <div className="activity-log">
      <div className="activity-log-title">LAST MOVE</div>
      <ul className="activity-log-list">{rows}</ul>
    </div>
  );
}

// "Tabloid" card tile.
function PlayingCard({ card, askable, selected, onClick }) {
  const rank = card[0];
  const suit = card[1];
  const glyph = SUIT_GLYPH[suit];
  const red = suit === "H" || suit === "D";
  const Tag = askable ? "button" : "div";
  return (
    <Tag
      type={askable ? "button" : undefined}
      className={
        "pcard" +
        (red ? " red" : "") +
        (selected ? " selected" : "") +
        (askable ? " askable" : "")
      }
      onClick={onClick}
    >
      <span className="pcard-corner tl">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{glyph}</span>
      </span>
      <span className="pcard-center">{glyph}</span>
      <span className="pcard-corner br">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{glyph}</span>
      </span>
    </Tag>
  );
}

function sortCards(a, b) {
  const ra = RANKS.indexOf(a[0]);
  const rb = RANKS.indexOf(b[0]);
  if (ra !== rb) return ra - rb;
  return a[1].localeCompare(b[1]);
}

function nameOf(players, id) {
  return players?.find((p) => p.id === id)?.name ?? id;
}

// Most recent set-making event in the log (or null) — drives the floating alert.
function findLatestSet(log) {
  if (!log) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === "set_collected" || log[i].kind === "declare_hit") return log[i];
  }
  return null;
}

// ── WINNER ─────────────────────────────────────────────────────────
function WinnerBanner({ view, me, onPlayAgain }) {
  const { winner, players, mode } = view;

  if (mode === "team") {
    return <TeamWinnerBanner view={view} me={me} onPlayAgain={onPlayAgain} />;
  }

  const tie = Array.isArray(winner);
  const winnerIds = tie ? winner : [winner];
  const youWon = winnerIds.includes(me);
  const { you, opponents } = view;

  const board = [
    { id: me, name: nameOf(players, me), sets: you.sets.length, isMe: true },
    ...opponents.map((o) => ({ id: o.id, name: o.name, sets: o.sets, isMe: false })),
  ].sort((a, b) => b.sets - a.sets);

  return (
    <div className="winner-wrap">
      <div className="champion-banner set-winner">
        <h2>Winner</h2>
        <div className="champion-name">
          {tie ? "TIE" : nameOf(players, winnerIds[0])}
        </div>
        <div className="champion-team">
          {tie
            ? winnerIds.map((id) => nameOf(players, id)).join(" / ") + " — split the spoils"
            : youWon
              ? "you cleaned house"
              : `${board[0].sets} sets collected`}
        </div>
      </div>
      <Leaderboard rows={board} winnerIds={winnerIds} />
      <div className="winner-cta">
        <button className="start-btn" onClick={onPlayAgain}>PLAY AGAIN →</button>
      </div>
    </div>
  );
}

function TeamWinnerBanner({ view, me, onPlayAgain }) {
  const { winner, teams, teamSets, players, yourTeam } = view;
  const tie = Array.isArray(winner);
  const winnerIds = tie ? winner : [winner];
  const youWon = !tie && winner === yourTeam;

  const headline = tie ? "TIE" : `TEAM ${winner}`;
  const a = teamSets.A.length, b = teamSets.B.length;
  const scoreLine = tie
    ? `Both teams tied ${a}-${b}.`
    : youWon
      ? `Your team took it, ${Math.max(a, b)}-${Math.min(a, b)}.`
      : `Lost ${Math.min(a, b)}-${Math.max(a, b)}.`;

  return (
    <div className="winner-wrap">
      <div className="champion-banner set-winner">
        <h2>Winner</h2>
        <div className="champion-name">{headline}</div>
        <div className="champion-team">{scoreLine}</div>
      </div>

      <div className="winner-board">
        <div className="winner-board-title">FINAL TABLE</div>
        {teams.map((t) => {
          const sets = teamSets[t.id] || [];
          const isWinner = winnerIds.includes(t.id);
          const isMine = t.id === yourTeam;
          return (
            <div
              key={t.id}
              className={
                "team-final" +
                (isWinner ? " winner-row-top" : "") +
                (isMine ? " winner-row-me" : "")
              }
            >
              <div className="team-final-head">
                <span className="team-final-name">
                  TEAM {t.id}
                  {isMine && <span className="muted"> (you)</span>}
                </span>
                <span className="team-final-score">
                  {sets.length} {sets.length === 1 ? "set" : "sets"}
                </span>
              </div>
              <div className="team-final-roster">
                {t.playerIds.map((pid) => (
                  <span key={pid} className="roster-name">
                    {nameOf(players, pid)}
                    {pid === me && <span className="muted"> (you)</span>}
                  </span>
                ))}
              </div>
              {sets.length > 0 && (
                <div className="team-final-ranks muted">
                  {sets.join(" · ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="winner-cta">
        <button className="start-btn" onClick={onPlayAgain}>PLAY AGAIN →</button>
      </div>
    </div>
  );
}

function Leaderboard({ rows, winnerIds }) {
  return (
    <div className="winner-board">
      <div className="winner-board-title">FINAL TABLE</div>
      {rows.map((p, i) => (
        <div
          key={p.id}
          className={
            "winner-row" +
            (winnerIds.includes(p.id) ? " winner-row-top" : "") +
            (p.isMe ? " winner-row-me" : "")
          }
        >
          <span className="winner-rank">{i + 1}</span>
          <span className="winner-name">
            {p.name}
            {p.isMe && <span className="muted"> (you)</span>}
          </span>
          <span className="winner-sets">
            {p.sets} {p.sets === 1 ? "set" : "sets"}
          </span>
        </div>
      ))}
    </div>
  );
}
