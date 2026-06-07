import { useState, useEffect, useRef } from "react";
import Reactions from "../../components/Reactions";
import { useRoom } from "../../utils/useRoom";
import { shareUrl, clientId } from "../../utils/room";

// Phase strings mirror the engine's PHASE enum (kept inline to avoid pulling
// engine internals into the bundle path unnecessarily).
const P_DESCRIBE = "describe";
const P_VOTE = "vote";
const P_MRWHITE = "mrwhite_guess";
const P_OVER = "over";

const ROLE_LABEL = {
  civilian: "CIVILIAN",
  undercover: "UNDERCOVER",
  mrwhite: "MR. WHITE",
};

export default function UndercoverApp({ code, onLeave }) {
  const me = clientId();
  const {
    state: view,
    presence,
    reactions,
    connected,
    error,
    dismissError,
    sendAction,
    sendReaction,
  } = useRoom(code, { game: "undercover", clientId: me });

  const stage = view?.stage || "lobby"; // "lobby" | "playing"
  const seated = !!view?.players?.find((p) => p.id === me);
  const [name, setName] = useState("");

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = shareUrl(code, "undercover");
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

  const handleReset = () => {
    if (!window.confirm("Start a new round with the same players?")) return;
    sendAction({ type: "uc_reset" });
  };

  const playing = stage === "playing";
  const over = playing && view?.phase === P_OVER;

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          UNDERCOVER<span className="slash">/</span>WHO IS THE SPY
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {playing && (
            <button className="room" onClick={handleReset} title="New round">
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

      <main>
        {stage === "lobby" && (
          <Lobby
            name={name}
            setName={setName}
            onJoin={handleJoin}
            joined={seated}
            view={view}
            me={me}
            onSetRoles={(undercover, mrWhite) =>
              sendAction({ type: "uc_setRoles", undercover, mrWhite })
            }
            onStart={() => sendAction({ type: "uc_start" })}
          />
        )}

        {playing && !over && (
          <Game
            view={view}
            me={me}
            onClue={(clue) => sendAction({ type: "uc_clue", clue })}
            onVote={(targetId) => sendAction({ type: "uc_vote", targetId })}
            onGuess={(guess) => sendAction({ type: "uc_guess", guess })}
          />
        )}

        {over && (
          <GameOver
            view={view}
            me={me}
            onPlayAgain={() => sendAction({ type: "uc_reset" })}
          />
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ───────────────────────────────────────────────────────────────
function Lobby({ name, setName, onJoin, joined, view, me, onSetRoles, onStart }) {
  const players = view?.players || [];
  const n = players.length;
  const roles = view?.roles || { undercover: 1, mrWhite: 0 };
  const canStart = n >= 4 && n <= 12;
  const civilians = n - roles.undercover - roles.mrWhite;
  const rolesValid =
    roles.undercover >= 1 &&
    roles.mrWhite >= 0 &&
    civilians > roles.undercover + roles.mrWhite;

  const bump = (key, delta) => {
    const next = { ...roles, [key]: Math.max(0, roles[key] + delta) };
    onSetRoles(next.undercover, next.mrWhite);
  };

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

      <div className="seated-list">
        <div className="seated-title">SEATED ({n}/12)</div>
        {n === 0 && <div className="muted">No one yet.</div>}
        {players.map((p) => (
          <div key={p.id || p.name} className="seated-row">
            <span>{p.name || "—"}</span>
            {p.id === me && <span className="muted"> (you)</span>}
          </div>
        ))}
      </div>

      {joined && n >= 4 && (
        <div className="uc-roles">
          <div className="uc-roles-title">ROLES</div>
          <div className="uc-role-grid">
            <RoleStepper
              label="UNDERCOVER"
              value={roles.undercover}
              onDec={() => bump("undercover", -1)}
              onInc={() => bump("undercover", 1)}
            />
            <RoleStepper
              label="MR. WHITE"
              value={roles.mrWhite}
              onDec={() => bump("mrWhite", -1)}
              onInc={() => bump("mrWhite", 1)}
            />
            <div className="uc-role-cell">
              <div className="uc-role-label">CIVILIANS</div>
              <div className="uc-role-value">{Math.max(0, civilians)}</div>
            </div>
          </div>
          {!rolesValid && (
            <div className="muted small">
              Civilians must outnumber undercover + Mr. White.
            </div>
          )}
        </div>
      )}

      {joined && (
        <button
          className="start-btn deal-btn"
          onClick={onStart}
          disabled={!canStart || !rolesValid}
        >
          START →
        </button>
      )}
      {joined && n < 4 && (
        <div className="muted">Need at least 4 players to start.</div>
      )}
    </div>
  );
}

function RoleStepper({ label, value, onDec, onInc }) {
  return (
    <div className="uc-role-cell">
      <div className="uc-role-label">{label}</div>
      <div className="uc-stepper">
        <button className="uc-step-btn" onClick={onDec} aria-label={`fewer ${label}`}>−</button>
        <span className="uc-role-value">{value}</span>
        <button className="uc-step-btn" onClick={onInc} aria-label={`more ${label}`}>+</button>
      </div>
    </div>
  );
}

// ── IN GAME ───────────────────────────────────────────────────────────────
function Game({ view, me, onClue, onVote, onGuess }) {
  const { phase, round, players, you, clues, currentDescriber } = view;
  const myTurn = phase === P_DESCRIBE && currentDescriber === me;
  const iAmDead = you && !you.alive;

  return (
    <div className="uc-table">
      <WordCard you={you} round={round} phase={phase} />

      <PlayersStrip players={players} me={me} view={view} />

      {phase === P_DESCRIBE && (
        <DescribePanel
          view={view}
          me={me}
          myTurn={myTurn}
          iAmDead={iAmDead}
          onClue={onClue}
        />
      )}

      {phase === P_VOTE && (
        <VotePanel view={view} me={me} iAmDead={iAmDead} onVote={onVote} />
      )}

      {phase === P_MRWHITE && (
        <MrWhitePanel view={view} me={me} onGuess={onGuess} />
      )}

      <ClueBoard clues={clues} round={round} players={players} me={me} />
      <LastEvent view={view} me={me} />
    </div>
  );
}

function WordCard({ you, round, phase }) {
  if (!you) {
    return (
      <div className="uc-word-card spectator">
        <div className="uc-word-label">SPECTATING · ROUND {round}</div>
        <div className="uc-word muted">words hidden</div>
      </div>
    );
  }
  const blank = you.isMrWhite;
  return (
    <div className={"uc-word-card" + (blank ? " mrwhite" : "") + (!you.alive ? " dead" : "")}>
      <div className="uc-word-label">
        YOUR WORD · ROUND {round}
        {!you.alive && <span className="uc-dead-tag"> · ELIMINATED</span>}
      </div>
      <div className="uc-word">{you.word}</div>
      {blank && (
        <div className="muted small">
          You&apos;re blank — blend in, and if caught, guess the civilian word to win.
        </div>
      )}
      {phase === P_DESCRIBE && you.alive && (
        <div className="muted small">Don&apos;t say your word. Give a one-line clue.</div>
      )}
    </div>
  );
}

function PlayersStrip({ players, me, view }) {
  const { currentDescriber, votedIds = [], phase } = view;
  return (
    <div className="players-strip" aria-label="Players">
      {players.map((p) => {
        const isTurn = phase === P_DESCRIBE && p.id === currentDescriber;
        const voted = phase === P_VOTE && votedIds.includes(p.id);
        const cls =
          "player-pip" +
          (isTurn ? " is-turn" : "") +
          (!p.alive ? " uc-dead" : "") +
          (voted ? " uc-voted" : "");
        return (
          <div key={p.id} className={cls}>
            {isTurn && <span className="player-pip-dot" aria-hidden="true" />}
            <span className="player-pip-name">
              {p.name}
              {p.id === me && <span className="player-pip-you"> (you)</span>}
            </span>
            {!p.alive && p.role && (
              <span className="uc-role-pill">{ROLE_LABEL[p.role]}</span>
            )}
            {p.alive && voted && <span className="player-pip-cards">✓</span>}
          </div>
        );
      })}
    </div>
  );
}

function DescribePanel({ view, me, myTurn, iAmDead, onClue }) {
  const [text, setText] = useState("");
  const { currentDescriber, players, you } = view;
  const curName = players.find((p) => p.id === currentDescriber)?.name || "someone";
  const alreadyDescribed =
    view.clues?.[view.round]?.[me] !== undefined;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onClue(t);
    setText("");
  };

  if (iAmDead) {
    return (
      <div className="uc-panel">
        <div className="set-status"><span>You&apos;re out. Waiting on {curName} to describe…</span></div>
      </div>
    );
  }

  if (!myTurn) {
    return (
      <div className="uc-panel">
        <div className="set-status">
          <span>Waiting on <strong>{curName}</strong> to describe…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="uc-panel">
      <div className="set-status"><strong>YOUR TURN — describe your word</strong></div>
      <div className="setup-row">
        <input
          className="text-input"
          placeholder={you?.isMrWhite ? "Bluff something plausible…" : "One-line clue (not the word)"}
          value={text}
          maxLength={120}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button className="start-btn" onClick={submit} disabled={!text.trim() || alreadyDescribed}>
          SUBMIT →
        </button>
      </div>
    </div>
  );
}

function VotePanel({ view, me, iAmDead, onVote }) {
  const { players, voteCandidates, votedIds = [], you } = view;
  const alive = players.filter((p) => p.alive);
  const candidates = voteCandidates
    ? alive.filter((p) => voteCandidates.includes(p.id))
    : alive;
  const iVoted = votedIds.includes(me);

  if (iAmDead || !you) {
    return (
      <div className="uc-panel">
        <div className="set-status">
          <span>
            Voting in progress — {votedIds.length}/{alive.length} cast.
            {voteCandidates && " (revote among tied players)"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="uc-panel">
      <div className="set-status">
        {iVoted ? (
          <span>Vote locked in. Waiting… ({votedIds.length}/{alive.length})</span>
        ) : (
          <strong>
            VOTE OUT A SUSPECT{voteCandidates ? " — tie revote" : ""}
          </strong>
        )}
      </div>
      <div className="opponent-row">
        {candidates.map((p) => (
          <button
            key={p.id}
            className="opponent"
            disabled={p.id === me || iVoted}
            onClick={() => onVote(p.id)}
          >
            <div className="opponent-name">{p.name}{p.id === me && " (you)"}</div>
            <div className="opponent-meta">
              {votedIds.includes(p.id) ? "voted" : "—"}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function MrWhitePanel({ view, me, onGuess }) {
  const [text, setText] = useState("");
  const { pendingMrWhite, players } = view;
  const isMe = pendingMrWhite === me;
  const mwName = players.find((p) => p.id === pendingMrWhite)?.name || "Mr. White";

  if (!isMe) {
    return (
      <div className="uc-panel">
        <div className="set-status">
          <strong>{mwName} was Mr. White!</strong>{" "}
          <span>One guess at the civilian word to steal the win…</span>
        </div>
      </div>
    );
  }

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onGuess(t);
    setText("");
  };

  return (
    <div className="uc-panel">
      <div className="set-status">
        <strong>YOU&apos;RE MR. WHITE — caught!</strong>{" "}
        <span>Guess the civilian word to win instantly.</span>
      </div>
      <div className="setup-row">
        <input
          className="text-input"
          placeholder="The civilian word is…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          autoFocus
        />
        <button className="start-btn" onClick={submit} disabled={!text.trim()}>
          GUESS →
        </button>
      </div>
    </div>
  );
}

// Public clues, grouped by round, latest round expanded.
function ClueBoard({ clues, round, players, me }) {
  if (!clues) return null;
  const nameOf = (id) => (id === me ? "You" : players.find((p) => p.id === id)?.name || id);
  const thisRound = clues[round] || {};
  const entries = Object.entries(thisRound);
  if (entries.length === 0) return null;
  return (
    <div className="uc-clueboard">
      <div className="uc-clueboard-title">CLUES · ROUND {round}</div>
      <ul className="uc-clue-list">
        {entries.map(([pid, clue]) => (
          <li key={pid} className="uc-clue-row">
            <span className="uc-clue-who">{nameOf(pid)}</span>
            <span className="uc-clue-text">{clue}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Show ONLY the most recent meaningful public event.
function LastEvent({ view, me }) {
  const { log, players } = view;
  if (!log || log.length === 0) return null;
  const nameOf = (id) => (id === me ? "You" : players.find((p) => p.id === id)?.name || id);

  const interesting = log.filter((e) =>
    ["eliminated", "tie_revote", "tie_no_elim", "mrwhite_eliminated", "mrwhite_guess", "round"].includes(e.kind)
  );
  const e = interesting[interesting.length - 1];
  if (!e) return null;

  let line = null;
  switch (e.kind) {
    case "eliminated":
      line = <><strong>{nameOf(e.who)}</strong> was eliminated — they were <strong>{ROLE_LABEL[e.role]}</strong>.</>;
      break;
    case "mrwhite_eliminated":
      line = <><strong>{nameOf(e.who)}</strong> was Mr. White — they get one guess.</>;
      break;
    case "mrwhite_guess":
      line = <><strong>{nameOf(e.who)}</strong> guessed “{e.guess}” — {e.correct ? "correct!" : "wrong."}</>;
      break;
    case "tie_revote":
      line = <>Tie vote — revote among the tied suspects.</>;
      break;
    case "tie_no_elim":
      line = <>Tie again — no one eliminated this round.</>;
      break;
    case "round":
      line = <>Round {e.round} begins.</>;
      break;
    default:
      return null;
  }
  return (
    <div className="activity-log">
      <div className="activity-log-title">LAST MOVE</div>
      <ul className="activity-log-list">
        <li className="log-row">{line}</li>
      </ul>
    </div>
  );
}

// ── GAME OVER ──────────────────────────────────────────────────────────────
function GameOver({ view, me, onPlayAgain }) {
  const { winner, players, civilianWord, undercoverWord, survivors = [], you } = view;

  const headline =
    winner === "civilians" ? "CIVILIANS WIN"
    : winner === "mrwhite" ? "MR. WHITE WINS"
    : "IMPOSTORS WIN";

  const myRole = you?.role;
  const iWon =
    (winner === "civilians" && myRole === "civilian") ||
    (winner === "impostors" && (myRole === "undercover" || myRole === "mrwhite")) ||
    (winner === "mrwhite" && myRole === "mrwhite");

  const survivorNames = survivors
    .map((id) => players.find((p) => p.id === id)?.name)
    .filter(Boolean);

  return (
    <div className="winner-wrap">
      <div className="champion-banner set-winner">
        <h2>{iWon ? "You won" : "Game over"}</h2>
        <div className="champion-name">{headline}</div>
        <div className="champion-team">
          Civilian word: <strong>{civilianWord}</strong> · Undercover word: <strong>{undercoverWord}</strong>
          {winner === "impostors" && survivorNames.length > 0 && (
            <> · Survivors: {survivorNames.join(", ")}</>
          )}
        </div>
      </div>

      <div className="winner-board">
        <div className="winner-board-title">ROLES REVEALED</div>
        {players.map((p) => (
          <div
            key={p.id}
            className={"winner-row" + (p.id === me ? " winner-row-me" : "")}
          >
            <span className="winner-name">
              {p.name}
              {p.id === me && <span className="muted"> (you)</span>}
            </span>
            <span className={"uc-role-pill uc-role-" + p.role}>
              {ROLE_LABEL[p.role]}{!p.alive && " · out"}
            </span>
          </div>
        ))}
      </div>

      <div className="winner-cta">
        <button className="start-btn" onClick={onPlayAgain}>PLAY AGAIN →</button>
      </div>
    </div>
  );
}
