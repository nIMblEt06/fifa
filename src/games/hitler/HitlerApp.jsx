import { useState, useEffect, useRef } from "react";
import Reactions from "../../components/Reactions";
import { useRoom } from "../../utils/useRoom";
import { shareUrl, clientId } from "../../utils/room";

// Secret Hitler — CC BY-NC-SA 4.0, Goat, Wolf & Cabbage (secrethitler.com).
// Private, non-commercial friends app — permitted by the license.

const ATTRIBUTION =
  "Secret Hitler · CC BY-NC-SA 4.0 · Goat, Wolf & Cabbage · secrethitler.com";

export default function HitlerApp({ code, onLeave }) {
  const me = clientId();
  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } =
    useRoom(code, { game: "hitler", clientId: me });

  const phase = view?.phase || "lobby";
  const inLobby = phase === "lobby";
  const seated = !!view?.players?.find((p) => p.id === me);
  const [name, setName] = useState("");

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "hitler")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const handleJoin = () => {
    const n = name.trim();
    if (!n) return;
    sendAction({ type: "join", name: n });
  };

  const send = (type, extra = {}) => sendAction({ type: `hitler:${type}`, ...extra });
  const handleReset = () => {
    if (!window.confirm("Reset the game back to the lobby?")) return;
    send("reset");
  };

  // Re-bind this WS to our clientId after refresh/reconnect.
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

  const started = !inLobby && !!view?.players;

  return (
    <div className="app sh-app">
      <header className="masthead">
        <h1>
          SECRET<span className="slash">/</span>HITLER
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

      <main>
        {inLobby && (
          <Lobby
            name={name}
            setName={setName}
            onJoin={handleJoin}
            onStart={() => send("start")}
            view={view}
            me={me}
            joined={seated}
          />
        )}
        {started && (
          <Table view={view} me={me} send={send} onReset={() => send("reset")} />
        )}
      </main>

      <div className="sh-attribution">{ATTRIBUTION}</div>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ───────────────────────────────────────────────────────────────────
function Lobby({ name, setName, onJoin, joined, onStart, view, me }) {
  const players = view?.players || [];
  const canStart = players.length >= 5 && players.length <= 10;

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
        <div className="seated-title">SEATED ({players.length}/10)</div>
        {players.length === 0 && <div className="muted">No one yet.</div>}
        {players.map((p) => (
          <div key={p.id || p.name} className="seated-row">
            <span>{p.name || "—"}</span>
            {p.id === me && <span className="muted"> (you)</span>}
          </div>
        ))}
      </div>

      {joined && (
        <button className="start-btn deal-btn" onClick={onStart} disabled={!canStart}>
          BEGIN →
        </button>
      )}
      {joined && players.length < 5 && (
        <div className="muted">Need at least 5 players (max 10).</div>
      )}
      {joined && players.length > 10 && (
        <div className="muted">Too many players — max 10.</div>
      )}

      <div className="sh-lobby-note muted">
        A game of hidden roles. Liberals must enact 5 liberal policies or
        execute Hitler. Fascists must enact 6 fascist policies — or get Hitler
        elected Chancellor once 3 fascist policies are down.
      </div>
    </div>
  );
}

// ── TABLE (in-game) ──────────────────────────────────────────────────────────
function Table({ view, me, send, onReset }) {
  const {
    players, president, chancellor, nominee, winner, you,
    liberalPolicies, fascistPolicies, electionTracker, deckCount,
  } = view;

  const meAlive = you?.alive !== false && !!you;
  const isPresident = president === me;
  const isChancellor = chancellor === me;

  if (winner) {
    return <GameOver view={view} me={me} onReset={onReset} />;
  }

  return (
    <div className="sh-table">
      <Tracks
        liberal={liberalPolicies}
        fascist={fascistPolicies}
        tracker={electionTracker}
        deckCount={deckCount}
        playerCount={view.playerCount}
      />

      <RoleCard you={you} players={players} />

      <PlayersRing
        players={players}
        president={president}
        chancellor={chancellor}
        nominee={nominee}
        me={me}
      />

      <PhasePanel
        view={view}
        me={me}
        send={send}
        isPresident={isPresident}
        isChancellor={isChancellor}
        meAlive={meAlive}
      />

      <LastEvent view={view} me={me} />
    </div>
  );
}

// Policy tracks + election tracker + deck.
function Tracks({ liberal, fascist, tracker, deckCount, playerCount }) {
  return (
    <div className="sh-tracks">
      <div className="sh-track sh-track-lib">
        <div className="sh-track-label">LIBERAL · {liberal}/5</div>
        <div className="sh-track-slots">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={"sh-slot" + (i < liberal ? " filled lib" : "")} />
          ))}
        </div>
      </div>
      <div className="sh-track sh-track-fas">
        <div className="sh-track-label">FASCIST · {fascist}/6</div>
        <div className="sh-track-slots">
          {Array.from({ length: 6 }, (_, i) => {
            const power = i + 1 >= 1 ? powerHint(playerCount, i + 1) : null;
            return (
              <span
                key={i}
                className={"sh-slot" + (i < fascist ? " filled fas" : "")}
                title={power || ""}
              >
                {power && i >= fascist ? <span className="sh-slot-power">{power}</span> : null}
              </span>
            );
          })}
        </div>
      </div>
      <div className="sh-meta-row">
        <span className="sh-tracker">
          ELECTION TRACKER:{" "}
          {[0, 1, 2].map((i) => (
            <span key={i} className={"sh-tracker-dot" + (i < tracker ? " on" : "")} />
          ))}
        </span>
        <span className="muted">Deck: {deckCount}</span>
      </div>
    </div>
  );
}

function powerHint(playerCount, fascistSlot) {
  // short labels for the upcoming-power markers on the fascist track
  const k = powerKindFor(playerCount, fascistSlot);
  return ({
    investigate: "INV",
    special_election: "ELEC",
    peek: "PEEK",
    execution: "KILL",
  })[k] || null;
}

function powerKindFor(playerCount, fascistCount) {
  if (playerCount <= 6) {
    if (fascistCount === 3) return "peek";
    if (fascistCount === 4 || fascistCount === 5) return "execution";
    return null;
  }
  if (playerCount <= 8) {
    if (fascistCount === 2) return "investigate";
    if (fascistCount === 3) return "special_election";
    if (fascistCount === 4 || fascistCount === 5) return "execution";
    return null;
  }
  if (fascistCount === 1 || fascistCount === 2) return "investigate";
  if (fascistCount === 3) return "special_election";
  if (fascistCount === 4 || fascistCount === 5) return "execution";
  return null;
}

// Your secret role + any teammates you know about.
function RoleCard({ you, players }) {
  if (!you) {
    return <div className="sh-role sh-role-spectator">SPECTATING — roles hidden</div>;
  }
  const known = players.filter((p) => p.role && p.id !== you.id);
  const partyClass = you.party === "liberal" ? "lib" : "fas";
  const roleLabel =
    you.role === "hitler" ? "HITLER" : you.role === "fascist" ? "FASCIST" : "LIBERAL";
  return (
    <div className={"sh-role " + partyClass + (you.alive === false ? " dead" : "")}>
      <div className="sh-role-head">
        YOU ARE <strong>{roleLabel}</strong>
        {you.alive === false && <span className="sh-dead-tag"> · EXECUTED</span>}
      </div>
      {known.length > 0 && (
        <div className="sh-role-known">
          {you.role === "hitler" ? "The Fascist: " : "Your team: "}
          {known.map((p) => (
            <span key={p.id} className="sh-known-name">
              {p.name}
              {p.role === "hitler" ? " (Hitler)" : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PlayersRing({ players, president, chancellor, nominee, me }) {
  return (
    <div className="sh-ring">
      {players.map((p) => {
        const tags = [];
        if (p.id === president) tags.push("PRES");
        if (p.id === chancellor) tags.push("CHANC");
        else if (p.id === nominee) tags.push("NOMINEE");
        return (
          <div
            key={p.id}
            className={
              "sh-seat" +
              (p.alive === false ? " dead" : "") +
              (p.id === me ? " is-me" : "") +
              (p.id === president ? " pres" : "") +
              (p.id === chancellor ? " chanc" : "")
            }
          >
            <div className="sh-seat-name">
              {p.name}
              {p.id === me && <span className="muted"> (you)</span>}
            </div>
            <div className="sh-seat-tags">
              {p.alive === false && <span className="sh-tag dead">EXECUTED</span>}
              {tags.map((t) => (
                <span key={t} className="sh-tag">{t}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// The interactive panel for the current phase.
function PhasePanel({ view, me, send, isPresident, isChancellor, meAlive }) {
  const {
    phase, players, president, nominee, eligibleChancellors = [],
    votedIds = [], lastVotes, pendingPower, vetoUnlocked,
    presidentDraw, chancellorCards, peek, investigationResult, investigated = [],
  } = view;

  const nameOf = (id) => players.find((p) => p.id === id)?.name ?? id;
  const alivePlayers = players.filter((p) => p.alive !== false);

  // ── Nomination ──
  if (phase === "nomination") {
    if (isPresident) {
      return (
        <div className="sh-panel">
          <div className="sh-panel-title">YOU ARE PRESIDENT — nominate a Chancellor</div>
          <div className="sh-choice-grid">
            {eligibleChancellors.map((id) => (
              <button key={id} className="sh-choice" onClick={() => send("nominate", { targetId: id })}>
                {nameOf(id)}
              </button>
            ))}
          </div>
          {eligibleChancellors.length === 0 && <div className="muted">No eligible chancellors.</div>}
        </div>
      );
    }
    return <Waiting text={`Waiting for President ${nameOf(president)} to nominate a Chancellor…`} />;
  }

  // ── Voting ──
  if (phase === "voting") {
    const iVoted = votedIds.includes(me);
    return (
      <div className="sh-panel">
        <div className="sh-panel-title">
          VOTE — {nameOf(president)} for President, {nameOf(nominee)} for Chancellor
        </div>
        {!meAlive ? (
          <div className="muted">You are executed — you cannot vote.</div>
        ) : iVoted ? (
          <div className="muted">Your vote is in. Waiting for others…</div>
        ) : (
          <div className="sh-vote-buttons">
            <button className="sh-vote ja" onClick={() => send("vote", { vote: "ja" })}>JA!</button>
            <button className="sh-vote nein" onClick={() => send("vote", { vote: "nein" })}>NEIN!</button>
          </div>
        )}
        <div className="sh-vote-progress muted">
          {votedIds.length}/{alivePlayers.length} voted
        </div>
      </div>
    );
  }

  // ── Legislative: President discards ──
  if (phase === "legislative_president") {
    if (isPresident && presidentDraw) {
      return (
        <div className="sh-panel">
          <div className="sh-panel-title">LEGISLATIVE — discard ONE policy, pass two on</div>
          <div className="sh-cards">
            {presidentDraw.map((c, i) => (
              <button key={i} className={"sh-policy " + c} onClick={() => send("discard", { index: i })}>
                {c === "liberal" ? "LIBERAL" : "FASCIST"}
                <span className="sh-policy-x">DISCARD</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    return <Waiting text={`President ${nameOf(president)} is reviewing 3 policies…`} />;
  }

  // ── Legislative: Chancellor enacts ──
  if (phase === "legislative_chancellor") {
    if (isChancellor && chancellorCards) {
      return (
        <div className="sh-panel">
          <div className="sh-panel-title">ENACT ONE policy</div>
          <div className="sh-cards">
            {chancellorCards.map((c, i) => (
              <button key={i} className={"sh-policy " + c} onClick={() => send("enact", { index: i })}>
                {c === "liberal" ? "LIBERAL" : "FASCIST"}
                <span className="sh-policy-x">ENACT</span>
              </button>
            ))}
          </div>
          {vetoUnlocked && (
            <button className="room sh-veto-btn" onClick={() => send("proposeVeto")}>
              PROPOSE VETO
            </button>
          )}
        </div>
      );
    }
    return <Waiting text="Chancellor is enacting a policy…" />;
  }

  // ── Veto ──
  if (phase === "veto") {
    if (isPresident) {
      return (
        <div className="sh-panel">
          <div className="sh-panel-title">VETO PROPOSED — agree to discard both policies?</div>
          <div className="sh-vote-buttons">
            <button className="sh-vote ja" onClick={() => send("respondVeto", { consent: true })}>AGREE</button>
            <button className="sh-vote nein" onClick={() => send("respondVeto", { consent: false })}>REFUSE</button>
          </div>
        </div>
      );
    }
    return <Waiting text="Chancellor proposed a veto. Waiting on the President…" />;
  }

  // ── Powers ──
  if (phase === "power" && pendingPower) {
    const kind = pendingPower.kind;
    if (kind === "peek") {
      if (isPresident) {
        return (
          <div className="sh-panel">
            <div className="sh-panel-title">POLICY PEEK — top 3 of the deck (you only)</div>
            <div className="sh-cards sh-cards-static">
              {(peek || []).map((c, i) => (
                <div key={i} className={"sh-policy " + c}>{c === "liberal" ? "LIBERAL" : "FASCIST"}</div>
              ))}
            </div>
            <button className="start-btn" onClick={() => send("peekAck")}>DONE →</button>
          </div>
        );
      }
      return <Waiting text={`President ${nameOf(president)} is peeking at the deck…`} />;
    }

    if (kind === "investigate") {
      if (isPresident) {
        return (
          <div className="sh-panel">
            <div className="sh-panel-title">INVESTIGATE LOYALTY — pick a player to inspect</div>
            {investigationResult ? (
              <div className="sh-investigation">
                <strong>{nameOf(investigationResult.target)}</strong> is{" "}
                <strong className={investigationResult.party === "liberal" ? "lib" : "fas"}>
                  {investigationResult.party === "liberal" ? "LIBERAL" : "FASCIST"}
                </strong>
              </div>
            ) : (
              <PlayerPicker
                players={alivePlayers}
                me={me}
                disabledIds={investigated}
                onPick={(id) => send("investigate", { targetId: id })}
              />
            )}
          </div>
        );
      }
      return <Waiting text={`President ${nameOf(president)} is investigating someone…`} />;
    }

    if (kind === "special_election") {
      if (isPresident) {
        return (
          <div className="sh-panel">
            <div className="sh-panel-title">SPECIAL ELECTION — choose the next President</div>
            <PlayerPicker
              players={alivePlayers}
              me={me}
              onPick={(id) => send("specialElection", { targetId: id })}
            />
          </div>
        );
      }
      return <Waiting text={`President ${nameOf(president)} is picking the next President…`} />;
    }

    if (kind === "execution") {
      if (isPresident) {
        return (
          <div className="sh-panel">
            <div className="sh-panel-title">EXECUTION — choose a player to execute</div>
            <PlayerPicker
              players={alivePlayers}
              me={me}
              onPick={(id) => send("execute", { targetId: id })}
            />
          </div>
        );
      }
      return <Waiting text={`President ${nameOf(president)} is choosing a target…`} />;
    }
  }

  // Show last vote result while between phases.
  if (lastVotes) {
    return (
      <div className="sh-panel">
        <div className="muted">Last election: {lastVotes.passed ? "PASSED" : "FAILED"} ({lastVotes.ja} Ja / {lastVotes.nein} Nein)</div>
      </div>
    );
  }
  return <Waiting text="…" />;
}

function PlayerPicker({ players, me, onPick, disabledIds = [] }) {
  return (
    <div className="sh-choice-grid">
      {players
        .filter((p) => p.id !== me)
        .map((p) => {
          const disabled = disabledIds.includes(p.id);
          return (
            <button
              key={p.id}
              className={"sh-choice" + (disabled ? " disabled" : "")}
              disabled={disabled}
              title={disabled ? "Already investigated" : ""}
              onClick={() => onPick(p.id)}
            >
              {p.name}
            </button>
          );
        })}
    </div>
  );
}

function Waiting({ text }) {
  return (
    <div className="sh-panel sh-waiting">
      <span className="muted">{text}</span>
    </div>
  );
}

// Activity panel — shows ONLY the most recent public event (hub convention).
function LastEvent({ view, me }) {
  const { log, players } = view;
  if (!log || log.length === 0) return null;
  const nameOf = (id) => (id === me ? "You" : players.find((p) => p.id === id)?.name ?? id);

  const visible = log.filter((e) => e.kind !== "start" && e.kind !== "legislative_start");
  const e = visible[visible.length - 1];
  if (!e) return null;

  let line = null;
  switch (e.kind) {
    case "nominate":
      line = <><strong>{nameOf(e.president)}</strong> nominated <strong>{nameOf(e.nominee)}</strong> for Chancellor</>;
      break;
    case "vote_result":
      line = (
        <>
          Election {e.passed ? "PASSED" : "FAILED"} — {e.ja} Ja / {e.nein} Nein
          {e.passed && <> · <strong>{nameOf(e.chancellor)}</strong> is Chancellor</>}
        </>
      );
      break;
    case "election_failed":
      line = <>Election failed — tracker at {e.tracker}</>;
      break;
    case "policy_enacted":
      line = <>A <strong className={e.policy === "liberal" ? "lib" : "fas"}>{e.policy === "liberal" ? "LIBERAL" : "FASCIST"}</strong> policy was enacted</>;
      break;
    case "chaos_enact":
      line = <>Chaos! Top policy auto-enacted ({e.policy === "liberal" ? "Liberal" : "Fascist"})</>;
      break;
    case "power":
      line = <><strong>{nameOf(e.president)}</strong> holds a presidential power: {e.power}</>;
      break;
    case "investigated":
      line = <><strong>{nameOf(e.president)}</strong> investigated <strong>{nameOf(e.target)}</strong></>;
      break;
    case "special_election":
      line = <><strong>{nameOf(e.president)}</strong> called a special election: <strong>{nameOf(e.target)}</strong></>;
      break;
    case "executed":
      line = <><strong>{nameOf(e.president)}</strong> executed <strong>{nameOf(e.target)}</strong></>;
      break;
    case "veto_proposed":
      line = <><strong>{nameOf(e.chancellor)}</strong> proposed a veto</>;
      break;
    case "veto_agreed":
      line = <>Veto agreed — both policies discarded</>;
      break;
    case "veto_rejected":
      line = <>Veto refused — Chancellor must enact</>;
      break;
    case "peeked":
      line = <><strong>{nameOf(e.president)}</strong> peeked at the deck</>;
      break;
    case "gameover":
      line = <>Game over — {e.winner === "liberal" ? "Liberals" : "Fascists"} win</>;
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

// ── GAME OVER ────────────────────────────────────────────────────────────────
function GameOver({ view, me, onReset }) {
  const { winner, winReason, players } = view;
  const libWin = winner === "liberal";

  return (
    <div className="winner-wrap">
      <div className={"champion-banner sh-winner " + (libWin ? "lib" : "fas")}>
        <h2>Winner</h2>
        <div className="champion-name">{libWin ? "LIBERALS" : "FASCISTS"}</div>
        <div className="champion-team">{winReason}</div>
      </div>

      <div className="winner-board">
        <div className="winner-board-title">ROLES REVEALED</div>
        {players.map((p) => {
          const role = p.role;
          const isFas = role === "fascist" || role === "hitler";
          return (
            <div key={p.id} className={"winner-row" + (p.id === me ? " winner-row-me" : "")}>
              <span className="winner-name">
                {p.name}
                {p.id === me && <span className="muted"> (you)</span>}
                {p.alive === false && <span className="muted"> · executed</span>}
              </span>
              <span className={"winner-sets " + (isFas ? "fas" : "lib")}>
                {role === "hitler" ? "HITLER" : isFas ? "FASCIST" : "LIBERAL"}
              </span>
            </div>
          );
        })}
      </div>

      <div className="winner-cta">
        <button className="start-btn" onClick={onReset}>PLAY AGAIN →</button>
      </div>
      <div className="sh-attribution">{ATTRIBUTION}</div>
    </div>
  );
}
