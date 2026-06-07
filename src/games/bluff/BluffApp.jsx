import { useState, useEffect, useRef } from "react";
import Reactions from "../../components/Reactions";
import { useRoom } from "../../utils/useRoom";
import { shareUrl, clientId } from "../../utils/room";
import { RANKS, MAX_PLAY } from "./engine";

const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };

export default function BluffApp({ code, onLeave }) {
  const me = clientId();
  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } =
    useRoom(code, { game: "bluff", clientId: me });

  const phase = view?.phase || "lobby"; // "lobby" | "playing"
  const seated = !!view?.players?.find((p) => p.id === me);
  const [name, setName] = useState("");

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    const url = shareUrl(code, "bluff");
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

  const handleStart = () => sendAction({ type: "bluffStart" });
  const handlePlay = (cards, claim) => sendAction({ type: "bluffPlay", cards, claim });
  const handlePass = () => sendAction({ type: "bluffPass" });
  const handleCall = () => sendAction({ type: "bluffCall" });
  const handleReset = () => {
    if (!window.confirm("Reset the game?")) return;
    sendAction({ type: "bluffReset" });
  };

  const started = phase === "playing" && !!view?.you;
  const over = started && view.loser != null;
  const myTurn = started && !over && view.turn === me;

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

  // ── Floating bluff-reveal alert ────────────────────────────
  // Pops a toast whenever a bluff is called and the cards are revealed.
  const [bluffAlert, setBluffAlert] = useState(null);
  const [lastSeenSig, setLastSeenSig] = useState(undefined);
  const latestBluff = findLatestBluff(view?.log);
  const bluffSig = latestBluff ? `${latestBluff.t || 0}` : null;
  if (view && lastSeenSig === undefined) {
    setLastSeenSig(bluffSig); // baseline; never replay history
  } else if (view && bluffSig && bluffSig !== lastSeenSig) {
    setLastSeenSig(bluffSig);
    setBluffAlert({
      key: bluffSig,
      by: nameFor(view, latestBluff.by, me),
      against: nameFor(view, latestBluff.against, me),
      claim: latestBluff.claim,
      wasLie: latestBluff.wasLie,
      revealed: latestBluff.revealed || [],
      pickedUpBy: nameFor(view, latestBluff.pickedUpBy, me),
    });
  }
  useEffect(() => {
    if (!bluffAlert) return;
    const id = setTimeout(() => setBluffAlert(null), 3200);
    return () => clearTimeout(id);
  }, [bluffAlert]);

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          BLUFF<span className="slash">/</span>CHEAT
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

      {bluffAlert && (
        <div className={"bluff-alert" + (bluffAlert.wasLie ? " lie" : " truth")} role="status" key={bluffAlert.key}>
          <div className="bluff-alert-head">
            {bluffAlert.by} called BLUFF on {bluffAlert.against}
          </div>
          <div className="bluff-alert-cards">
            {bluffAlert.revealed.map((c) => (
              <PlayingCard key={c} card={c} />
            ))}
          </div>
          <div className="bluff-alert-verdict">
            {bluffAlert.wasLie
              ? `LIE! Claimed ${bluffAlert.claim}s — ${bluffAlert.pickedUpBy} eats the pile`
              : `TRUTH. ${bluffAlert.pickedUpBy} eats the pile`}
          </div>
        </div>
      )}

      <main>
        {phase === "lobby" && (
          <Lobby
            name={name}
            setName={setName}
            onJoin={handleJoin}
            onStart={handleStart}
            view={view}
            me={me}
            joined={seated}
          />
        )}

        {started && (
          <Table
            view={view}
            me={me}
            myTurn={myTurn}
            over={over}
            onPlay={handlePlay}
            onPass={handlePass}
            onCall={handleCall}
            onPlayAgain={() => sendAction({ type: "bluffReset" })}
          />
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ───────────────────────────────────────────────────────────
function Lobby({ name, setName, onJoin, joined, onStart, view, me }) {
  const players = view?.players || [];
  const canDeal = players.length >= 3 && players.length <= 8;

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
        <div className="seated-title">SEATED · {players.length}/8</div>
        {players.length === 0 && <div className="muted">No one yet.</div>}
        {players.map((p) => (
          <div key={p.id || p.name} className="seated-row">
            <span>{p.name || "—"}</span>
            {p.id === me && <span className="muted"> (you)</span>}
          </div>
        ))}
      </div>

      {joined && (
        <button className="start-btn deal-btn" onClick={onStart} disabled={!canDeal}>
          DEAL →
        </button>
      )}
      {joined && players.length < 3 && (
        <div className="muted">Need at least 3 players (3–8).</div>
      )}
    </div>
  );
}

// ── TABLE (in-game) ────────────────────────────────────────────────
function Table({ view, me, myTurn, over, onPlay, onPass, onCall, onPlayAgain }) {
  const { you, players, turn, claimRank, lastPlay, pileCount, burnedCount, roundPlays } = view;
  const [selected, setSelected] = useState([]); // card strings chosen to play
  const [claimChoice, setClaimChoice] = useState(null); // rank when opening a round

  // Reset the staging area whenever the turn changes (adjust-state-during-render
  // pattern, matching the rest of the codebase — avoids an effect).
  const [stagedTurn, setStagedTurn] = useState(turn);
  if (turn !== stagedTurn) {
    setStagedTurn(turn);
    if (selected.length) setSelected([]);
    if (claimChoice) setClaimChoice(null);
  }

  if (over) {
    return <ResultBanner view={view} me={me} onPlayAgain={onPlayAgain} />;
  }

  const roundOpen = claimRank != null;
  const canBluff = !!lastPlay && lastPlay.by !== me;
  const canPass = roundOpen; // can't pass to open a round
  const effectiveClaim = roundOpen ? claimRank : claimChoice;
  const canSubmitPlay =
    selected.length >= 1 &&
    selected.length <= MAX_PLAY &&
    !!effectiveClaim;

  const toggleCard = (c) => {
    if (!myTurn) return;
    setSelected((prev) =>
      prev.includes(c)
        ? prev.filter((x) => x !== c)
        : prev.length >= MAX_PLAY
          ? prev
          : [...prev, c]
    );
  };

  const submitPlay = () => {
    if (!canSubmitPlay) return;
    onPlay(selected, effectiveClaim);
    setSelected([]);
    setClaimChoice(null);
  };

  const handCountById = new Map([[me, you.hand.length]]);
  players.forEach((p) => handCountById.set(p.id, p.handCount));

  return (
    <div className="set-table">
      <PlayersStrip players={players} turn={turn} me={me} handCountById={handCountById} />

      {/* The pile in the middle — always face down. */}
      <div className="bluff-pile">
        <div className="bluff-pile-stack">
          <CardBack />
          <div className="bluff-pile-count">{pileCount}</div>
        </div>
        <div className="bluff-pile-meta">
          <div className="bluff-pile-label">THE PILE</div>
          {roundOpen ? (
            <div className="bluff-claim">
              Round rank: <span className="log-rank">{claimRank}</span>
              {lastPlay && (
                <span className="muted">
                  {" "}· {nameFor(view, lastPlay.by, me)} claimed {lastPlay.count} ×{" "}
                  {lastPlay.claim}
                </span>
              )}
            </div>
          ) : (
            <div className="muted">No round in play — opener declares a rank.</div>
          )}
          {burnedCount > 0 && (
            <div className="muted small">{burnedCount} cards burned</div>
          )}
        </div>
      </div>

      {roundPlays && roundPlays.length > 0 && (
        <div className="bluff-history">
          {roundPlays.map((p, i) => (
            <span key={i} className="bluff-history-chip">
              {nameFor(view, p.by, me)}: {p.count}×{p.claim}
            </span>
          ))}
        </div>
      )}

      <div className="set-status">
        {myTurn ? (
          <strong>YOUR TURN{roundOpen ? "" : " — open a round: pick cards + declare a rank"}</strong>
        ) : (
          <span>Waiting on {nameFor(view, turn, me)}…</span>
        )}
      </div>

      {/* Action bar: pass / bluff (only on your turn). */}
      {myTurn && (
        <div className="bluff-actions">
          <button className="poker-btn bluff-call" onClick={onCall} disabled={!canBluff}
            title={canBluff ? "Call out the last play" : "No play to challenge"}>
            CALL BLUFF
          </button>
          <button className="poker-btn" onClick={() => { setSelected([]); setClaimChoice(null); onPass(); }}
            disabled={!canPass} title={canPass ? "Pass" : "You must open the round"}>
            PASS
          </button>
        </div>
      )}

      {/* Open-a-round rank picker. */}
      {myTurn && !roundOpen && (
        <div className="bluff-rankpick">
          <div className="bluff-rankpick-label">DECLARE A RANK</div>
          <div className="declare-ranks">
            {RANKS.map((r) => (
              <button
                key={r}
                className={"declare-rank" + (claimChoice === r ? " picked" : "")}
                onClick={() => setClaimChoice(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="your-area">
        <div className="your-meta">YOU · {you.hand.length} cards</div>
        <div className="your-hand">
          {you.hand
            .slice()
            .sort(sortCards)
            .map((c) => (
              <PlayingCard
                key={c}
                card={c}
                askable={myTurn}
                selected={selected.includes(c)}
                onClick={() => toggleCard(c)}
              />
            ))}
        </div>

        {myTurn && (
          <div className="bluff-play-bar">
            <div className="muted bluff-play-hint">
              {selected.length === 0
                ? roundOpen
                  ? `Pick 1–${MAX_PLAY} cards to play face down (claiming ${claimRank}s).`
                  : `Pick 1–${MAX_PLAY} cards + a rank to declare.`
                : roundOpen
                  ? `Playing ${selected.length} face down, claiming ${claimRank}.`
                  : claimChoice
                    ? `Playing ${selected.length} face down, claiming ${claimChoice}.`
                    : `Playing ${selected.length} — now pick a rank to declare.`}
            </div>
            <button className="start-btn bluff-submit" onClick={submitPlay} disabled={!canSubmitPlay}>
              PLAY {selected.length || ""}{effectiveClaim ? ` AS ${effectiveClaim}` : ""} →
            </button>
          </div>
        )}
      </div>

      <ActivityLog log={view.log} view={view} me={me} />
    </div>
  );
}

function PlayersStrip({ players, turn, me, handCountById }) {
  return (
    <div className="players-strip" aria-label="Players">
      {players.map((p) => {
        const isTurn = p.id === turn;
        const isMe = p.id === me;
        const isOut = p.out;
        const cls =
          "player-pip" +
          (isTurn ? " is-turn" : "") +
          (isTurn && isMe ? " is-mine-turn" : "") +
          (isOut ? " is-out" : "");
        return (
          <div key={p.id} className={cls}>
            {isTurn && <span className="player-pip-dot" aria-hidden="true" />}
            <span className="player-pip-name">
              {p.name}
              {isMe && <span className="player-pip-you"> (you)</span>}
            </span>
            <span className="player-pip-cards">{isOut ? `OUT #${p.place}` : handCountById.get(p.id) ?? 0}</span>
          </div>
        );
      })}
    </div>
  );
}

function ActivityLog({ log, view, me }) {
  if (!log || log.length === 0) return null;
  const who = (id) => nameFor(view, id, me);
  const visible = log.filter((e) => e.kind !== "start");
  const e = visible[visible.length - 1];
  if (!e) return null;

  let line = null;
  let cls = "log-row";
  switch (e.kind) {
    case "play":
      line = (
        <>
          <strong>{who(e.by)}</strong> played <strong>{e.count}</strong> face down
          {", claiming "}<span className="log-rank">{e.claim}</span>
          {e.opened ? " (new round)" : ""}
          {e.wentOut ? " — went out!" : ""}
        </>
      );
      cls += " log-hit";
      break;
    case "pass":
      line = (<><strong>{who(e.by)}</strong> passed</>);
      cls += " log-miss";
      break;
    case "bluff":
      line = (
        <>
          <strong>{who(e.by)}</strong> called BLUFF on <strong>{who(e.against)}</strong> —{" "}
          {e.wasLie ? "LIE caught" : "it was true"}, <strong>{who(e.pickedUpBy)}</strong> takes the pile
        </>
      );
      cls += e.wasLie ? " log-set" : " log-miss";
      break;
    case "burn":
      line = (<><strong>{e.size}</strong> cards burned — <strong>{who(e.opener)}</strong> opens fresh</>);
      cls += " log-miss";
      break;
    case "out":
      line = (<><strong>{who(e.who)}</strong> is OUT (place #{e.place})</>);
      cls += " log-set";
      break;
    default:
      return null;
  }

  return (
    <div className="activity-log">
      <div className="activity-log-title">LAST MOVE</div>
      <ul className="activity-log-list">
        <li className={cls}>{line}</li>
      </ul>
    </div>
  );
}

// Face-up tabloid card.
function PlayingCard({ card, askable, selected, onClick }) {
  const rank = card[0];
  const suit = card[1];
  const glyph = SUIT_GLYPH[suit];
  const red = suit === "H" || suit === "D";
  const Tag = askable ? "button" : "div";
  return (
    <Tag
      type={askable ? "button" : undefined}
      className={"pcard" + (red ? " red" : "") + (selected ? " selected" : "") + (askable ? " askable" : "")}
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

// Face-down card back for the pile.
function CardBack() {
  return (
    <div className="pcard pcard-back" aria-hidden="true">
      <span className="pcard-back-mark">?</span>
    </div>
  );
}

function sortCards(a, b) {
  const ra = RANKS.indexOf(a[0]);
  const rb = RANKS.indexOf(b[0]);
  if (ra !== rb) return ra - rb;
  return a[1].localeCompare(b[1]);
}

function nameFor(view, id, me) {
  if (id === me) return "You";
  return view?.players?.find((p) => p.id === id)?.name ?? id;
}

function findLatestBluff(log) {
  if (!log) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].kind === "bluff") return log[i];
  }
  return null;
}

// ── RESULT ─────────────────────────────────────────────────────────
function ResultBanner({ view, me, onPlayAgain }) {
  const { players, loser, out } = view;
  const loserName = nameFor(view, loser, me);
  const youLost = loser === me;

  // Finish order: out[] in order, then the loser last.
  const board = [
    ...out.map((id, i) => ({ id, name: nameFor(view, id, me), place: i + 1, isMe: id === me, loser: false })),
    { id: loser, name: loserName, place: out.length + 1, isMe: youLost, loser: true },
  ];

  return (
    <div className="winner-wrap">
      <div className="champion-banner set-winner">
        <h2>Result</h2>
        <div className="champion-name">{youLost ? "EL CRAPICO" : loserName}</div>
        <div className="champion-team">
          {youLost
            ? "you're the crapico — last one stuck holding cards"
            : `${loserName} got stuck with the cards`}
        </div>
      </div>

      <div className="winner-board">
        <div className="winner-board-title">FINISH ORDER</div>
        {board.map((p) => (
          <div
            key={p.id}
            className={
              "winner-row" +
              (p.place === 1 ? " winner-row-top" : "") +
              (p.loser ? " winner-row-crapico" : "") +
              (p.isMe ? " winner-row-me" : "")
            }
          >
            <span className="winner-rank">{p.loser ? "💀" : p.place}</span>
            <span className="winner-name">
              {p.name}
              {p.isMe && <span className="muted"> (you)</span>}
            </span>
            <span className="winner-sets">
              {p.place === 1 ? "first out" : p.loser ? "crapico" : `#${p.place}`}
            </span>
          </div>
        ))}
        {players.length !== board.length && null}
      </div>

      <div className="winner-cta">
        <button className="start-btn" onClick={onPlayAgain}>PLAY AGAIN →</button>
      </div>
    </div>
  );
}
