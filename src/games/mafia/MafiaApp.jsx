import { useState, useEffect, useRef, useCallback } from "react";
import Reactions from "../../components/Reactions";
import { useRoom } from "../../utils/useRoom";
import { shareUrl, clientId } from "../../utils/room";
import {
  createInitialState,
  addPlayer,
  setConfig,
  startGame,
  postMafiaChat,
  castMafiaVote,
  castDoctorSave,
  castDetectiveCheck,
  nightActionsComplete,
  resolveNight,
  postDayChat,
  openVote,
  castDayVote,
  dayVoteComplete,
  resolveDayVote,
  resetToLobby,
  aliveMafia,
  ROLE,
  PHASE,
  SKIP,
  MIN_PLAYERS,
  MAX_PLAYERS,
  validateConfig,
} from "./engine.js";

const ROLE_LABEL = {
  [ROLE.MAFIA]: "MAFIA",
  [ROLE.DOCTOR]: "DOCTOR",
  [ROLE.DETECTIVE]: "DETECTIVE",
  [ROLE.VILLAGER]: "VILLAGER",
};

const ROLE_BLURB = {
  [ROLE.MAFIA]: "Agree with your fellow mafia on a target each night. Blend in by day.",
  [ROLE.DOCTOR]: "Protect one player each night — you may save yourself.",
  [ROLE.DETECTIVE]: "Investigate one player each night to learn if they're mafia.",
  [ROLE.VILLAGER]: "No night power. Survive, deduce, and vote out the mafia by day.",
};

function fmtClock(ms) {
  if (ms == null || ms < 0) ms = 0;
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function MafiaApp({ code, onLeave }) {
  const me = clientId();
  const { state: remoteState, presence, reactions, connected, sendState, sendReaction } =
    useRoom(code, { game: "mafia" });

  const state = { ...createInitialState(), ...(remoteState ?? {}) };
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });

  const apply = useCallback(
    (result) => {
      if (!result || result.error) return;
      sendState(result.state);
    },
    [sendState]
  );

  const update = useCallback(
    (fn) => {
      const base = { ...createInitialState(), ...(remoteState ?? {}) };
      apply(fn(base));
    },
    [remoteState, apply]
  );

  // No one is in charge — any connected client watches the clock/action
  // completion and drives the phase forward the instant it's resolvable.
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current;
      if (!s || s.phase === PHASE.LOBBY || s.phase === PHASE.OVER) return;
      const now = Date.now();
      const expired = s.phaseEndsAt != null && now >= s.phaseEndsAt;
      if (s.phase === PHASE.NIGHT) {
        if (nightActionsComplete(s) || expired) apply(resolveNight(s));
      } else if (s.phase === PHASE.DAY_DISCUSS) {
        if (expired) apply(openVote(s));
      } else if (s.phase === PHASE.DAY_VOTE) {
        if (dayVoteComplete(s) || expired) apply(resolveDayVote(s));
      }
    }, 500);
    return () => clearInterval(id);
  }, [apply]);

  const [name, setName] = useState("");
  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "mafia")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const seated = !!state.players.find((p) => p.id === me);
  const handleJoin = () => {
    const n = name.trim();
    if (!n) return;
    update((s) => addPlayer(s, me, n));
  };

  const handleReset = () => {
    if (!window.confirm("Return everyone to the lobby for a new game?")) return;
    update((s) => resetToLobby(s));
  };

  const over = state.phase === PHASE.OVER;

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          MAFIA<span className="slash">/</span>NIGHT FALLS
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {state.phase !== PHASE.LOBBY && (
            <button className="room" onClick={handleReset} title="New game">
              RESET
            </button>
          )}
          {presence > 0 && (
            <span className="presence">
              <span className="dot" />
              {presence} watching
            </span>
          )}
          <button className={"room " + (copied ? "copied" : "")} onClick={copyLink} title="Copy share link">
            {copied ? "LINK COPIED" : code}
          </button>
        </div>
      </header>

      {!connected && <div className="conn-state">RECONNECTING…</div>}

      <main>
        {state.phase === PHASE.LOBBY && (
          <Lobby
            name={name}
            setName={setName}
            onJoin={handleJoin}
            joined={seated}
            state={state}
            me={me}
            onSetConfig={(patch) => update((s) => setConfig(s, patch))}
            onStart={() => update((s) => startGame(s))}
          />
        )}

        {state.phase !== PHASE.LOBBY && !over && (
          <Game
            state={state}
            me={me}
            onMafiaChat={(text) => update((s) => postMafiaChat(s, me, text))}
            onMafiaVote={(targetId) => update((s) => castMafiaVote(s, me, targetId))}
            onDoctorSave={(targetId) => update((s) => castDoctorSave(s, me, targetId))}
            onDetectiveCheck={(targetId) => update((s) => castDetectiveCheck(s, me, targetId))}
            onDayChat={(text) => update((s) => postDayChat(s, me, text))}
            onDayVote={(targetId) => update((s) => castDayVote(s, me, targetId))}
          />
        )}

        {over && <GameOver state={state} me={me} onPlayAgain={handleReset} />}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ────────────────────────────────────────────────────────────────
function Lobby({ name, setName, onJoin, joined, state, me, onSetConfig, onStart }) {
  const players = state.players;
  const n = players.length;
  const config = state.config;
  const [settingsOpen, setSettingsOpen] = useState(false);
  const err = validateConfig(n, config);
  const canStart = n >= MIN_PLAYERS && n <= MAX_PLAYERS && !err;

  const bumpMafia = (delta) => onSetConfig({ mafiaCount: Math.max(1, config.mafiaCount + delta) });
  const bumpSeconds = (key, delta) => onSetConfig({ [key]: Math.max(15, config[key] + delta) });

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
        <div className="seated-title">SEATED ({n}/{MAX_PLAYERS})</div>
        {n === 0 && <div className="muted">No one yet.</div>}
        {players.map((p) => (
          <div key={p.id} className="seated-row">
            <span>{p.name}</span>
            {p.id === me && <span className="muted"> (you)</span>}
          </div>
        ))}
      </div>

      {joined && (
        <>
          {!settingsOpen ? (
            <button type="button" className="custom-room-toggle" onClick={() => setSettingsOpen(true)}>
              + GAME SETTINGS
            </button>
          ) : (
            <div className="uc-roles">
              <div className="uc-roles-title">ROLES</div>
              <div className="uc-role-grid">
                <div className="uc-role-cell">
                  <div className="uc-role-label">MAFIA</div>
                  <div className="uc-stepper">
                    <button className="uc-step-btn" onClick={() => bumpMafia(-1)} aria-label="fewer mafia">−</button>
                    <span className="uc-role-value">{config.mafiaCount}</span>
                    <button className="uc-step-btn" onClick={() => bumpMafia(1)} aria-label="more mafia">+</button>
                  </div>
                </div>
                <div className="uc-role-cell">
                  <div className="uc-role-label">DOCTOR</div>
                  <button
                    className={"mf-toggle" + (config.doctorEnabled ? " on" : "")}
                    onClick={() => onSetConfig({ doctorEnabled: !config.doctorEnabled })}
                  >
                    {config.doctorEnabled ? "ON" : "OFF"}
                  </button>
                </div>
                <div className="uc-role-cell">
                  <div className="uc-role-label">DETECTIVE</div>
                  <button
                    className={"mf-toggle" + (config.detectiveEnabled ? " on" : "")}
                    onClick={() => onSetConfig({ detectiveEnabled: !config.detectiveEnabled })}
                  >
                    {config.detectiveEnabled ? "ON" : "OFF"}
                  </button>
                </div>
              </div>

              <div className="uc-roles-title" style={{ marginTop: 14 }}>TIMERS</div>
              <div className="uc-role-grid">
                <TimerStepper label="NIGHT" seconds={config.nightSeconds} onBump={(d) => bumpSeconds("nightSeconds", d)} />
                <TimerStepper label="DAY DISCUSS" seconds={config.dayDiscussSeconds} onBump={(d) => bumpSeconds("dayDiscussSeconds", d)} />
                <TimerStepper label="DAY VOTE" seconds={config.dayVoteSeconds} onBump={(d) => bumpSeconds("dayVoteSeconds", d)} />
              </div>

              {err && <div className="muted small">{err}</div>}
            </div>
          )}

          <button className="start-btn deal-btn" onClick={onStart} disabled={!canStart}>
            START →
          </button>
          {n < MIN_PLAYERS && <div className="muted">Need at least {MIN_PLAYERS} players to start.</div>}
        </>
      )}
    </div>
  );
}

function TimerStepper({ label, seconds, onBump }) {
  return (
    <div className="uc-role-cell">
      <div className="uc-role-label">{label}</div>
      <div className="uc-stepper">
        <button className="uc-step-btn" onClick={() => onBump(-30)} aria-label={`less ${label}`}>−</button>
        <span className="uc-role-value">{fmtClock(seconds * 1000)}</span>
        <button className="uc-step-btn" onClick={() => onBump(30)} aria-label={`more ${label}`}>+</button>
      </div>
    </div>
  );
}

// ── IN GAME ──────────────────────────────────────────────────────────────
function Game({ state, me, onMafiaChat, onMafiaVote, onDoctorSave, onDetectiveCheck, onDayChat, onDayVote }) {
  const you = state.players.find((p) => p.id === me) || null;
  const [roleAck, setRoleAck] = useState(false);
  const prevPhaseRef = useRef(state.phase);
  useEffect(() => {
    if (prevPhaseRef.current === PHASE.LOBBY && state.phase !== PHASE.LOBBY) setRoleAck(false);
    prevPhaseRef.current = state.phase;
  }, [state.phase]);

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);
  const remaining = state.phaseEndsAt != null ? state.phaseEndsAt - now : null;

  if (you && !roleAck) {
    return <RoleReveal you={you} onAck={() => setRoleAck(true)} />;
  }

  return (
    <div className="uc-table">
      <PhaseBanner state={state} remaining={remaining} />
      <RosterStrip state={state} me={me} />

      {state.phase === PHASE.NIGHT && (
        <NightPanel
          state={state}
          you={you}
          onMafiaChat={onMafiaChat}
          onMafiaVote={onMafiaVote}
          onDoctorSave={onDoctorSave}
          onDetectiveCheck={onDetectiveCheck}
        />
      )}

      {(state.phase === PHASE.DAY_DISCUSS || state.phase === PHASE.DAY_VOTE) && (
        <DayPanel state={state} you={you} onDayChat={onDayChat} onDayVote={onDayVote} />
      )}

      <LastEvent state={state} me={me} />
    </div>
  );
}

function RoleReveal({ you, onAck }) {
  return (
    <div className="mf-reveal">
      <div className={"mf-role-card mf-role-" + you.role}>
        <div className="mf-role-label">YOU ARE</div>
        <div className="mf-role-name">{ROLE_LABEL[you.role]}</div>
        <div className="mf-role-blurb">{ROLE_BLURB[you.role]}</div>
      </div>
      <button className="start-btn" onClick={onAck}>GOT IT →</button>
    </div>
  );
}

function PhaseBanner({ state, remaining }) {
  const label =
    state.phase === PHASE.NIGHT ? "NIGHT FALLS"
    : state.phase === PHASE.DAY_DISCUSS ? "DAY · DISCUSSION"
    : state.phase === PHASE.DAY_VOTE ? "DAY · VOTE"
    : "";
  return (
    <div className="mf-phase-banner">
      <div className="mf-phase-label">ROUND {state.round} · {label}</div>
      <div className="mf-countdown">{fmtClock(remaining)}</div>
    </div>
  );
}

function RosterStrip({ state, me }) {
  const { players } = state;
  return (
    <div className="players-strip" aria-label="Players">
      {players.map((p) => (
        <div key={p.id} className={"player-pip" + (!p.alive ? " uc-dead" : "")}>
          <span className="player-pip-name">
            {p.name}
            {p.id === me && <span className="player-pip-you"> (you)</span>}
          </span>
          {!p.alive && p.role && <span className="uc-role-pill">{ROLE_LABEL[p.role]}</span>}
        </div>
      ))}
    </div>
  );
}

// ── NIGHT ────────────────────────────────────────────────────────────────
function NightPanel({ state, you, onMafiaChat, onMafiaVote, onDoctorSave, onDetectiveCheck }) {
  if (!you || !you.alive) {
    return (
      <div className="uc-panel">
        <div className="set-status"><span>The town sleeps. Waiting for night to resolve…</span></div>
      </div>
    );
  }

  if (you.role === ROLE.MAFIA) {
    return <MafiaNightPanel state={state} you={you} onMafiaChat={onMafiaChat} onMafiaVote={onMafiaVote} />;
  }
  if (you.role === ROLE.DOCTOR) {
    return <DoctorPanel state={state} you={you} onDoctorSave={onDoctorSave} />;
  }
  if (you.role === ROLE.DETECTIVE) {
    return <DetectivePanel state={state} you={you} onDetectiveCheck={onDetectiveCheck} />;
  }
  return (
    <div className="uc-panel">
      <div className="set-status"><span>You're asleep. The town's fate is being decided…</span></div>
    </div>
  );
}

function MafiaNightPanel({ state, you, onMafiaChat, onMafiaVote }) {
  const [text, setText] = useState("");
  const mafia = aliveMafia(state);
  const targets = state.players.filter((p) => p.alive && p.role !== ROLE.MAFIA);
  const myVote = state.night.mafiaVotes[you.id];
  const need = Math.floor(mafia.length / 2) + 1;

  const counts = new Map();
  for (const m of mafia) {
    const v = state.night.mafiaVotes[m.id];
    if (v && v !== SKIP) counts.set(v, (counts.get(v) || 0) + 1);
  }
  const leaderId = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const leaderCount = leaderId ? counts.get(leaderId) : 0;
  const leaderName = leaderId ? state.players.find((p) => p.id === leaderId)?.name : null;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onMafiaChat(t);
    setText("");
  };

  return (
    <div className="uc-panel">
      <div className="set-status">
        <strong>MAFIA — pick tonight's target</strong>{" "}
        {leaderName ? (
          <span>· {leaderName} {leaderCount}/{mafia.length} ({need} needed)</span>
        ) : (
          <span>· no consensus yet ({mafia.length} mafia, {need} needed)</span>
        )}
      </div>
      <div className="opponent-row">
        {targets.map((p) => (
          <button
            key={p.id}
            className={"opponent" + (myVote === p.id ? " selected" : "")}
            onClick={() => onMafiaVote(p.id)}
          >
            <div className="opponent-name">{p.name}</div>
            <div className="opponent-meta">{counts.get(p.id) || 0} vote(s)</div>
          </button>
        ))}
        <button
          className={"opponent" + (myVote === SKIP ? " selected" : "")}
          onClick={() => onMafiaVote(SKIP)}
        >
          <div className="opponent-name">NO KILL</div>
        </button>
      </div>

      <div className="mf-chat">
        <div className="mf-chat-list">
          {state.mafiaChat.slice(-30).map((m, i) => (
            <div key={i} className="mf-chat-row">
              <span className="mf-chat-who">{state.players.find((p) => p.id === m.by)?.name || "?"}</span>
              <span className="mf-chat-text">{m.text}</span>
            </div>
          ))}
        </div>
        <div className="setup-row">
          <input
            className="text-input"
            placeholder="Talk it over with the mafia…"
            value={text}
            maxLength={240}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button className="start-btn" onClick={submit} disabled={!text.trim()}>SEND →</button>
        </div>
      </div>
    </div>
  );
}

function DoctorPanel({ state, you, onDoctorSave }) {
  const picked = state.night.doctorSave;
  const targets = state.players.filter((p) => p.alive);
  return (
    <div className="uc-panel">
      <div className="set-status">
        {picked ? (
          <span>Protecting <strong>{targets.find((p) => p.id === picked)?.name}</strong> tonight.</span>
        ) : (
          <strong>DOCTOR — choose who to protect</strong>
        )}
      </div>
      <div className="opponent-row">
        {targets.map((p) => (
          <button
            key={p.id}
            className={"opponent" + (picked === p.id ? " selected" : "")}
            disabled={!!picked}
            onClick={() => onDoctorSave(p.id)}
          >
            <div className="opponent-name">{p.name}{p.id === you.id && " (you)"}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function DetectivePanel({ state, you, onDetectiveCheck }) {
  const check = state.night.detectiveCheck;
  const targets = state.players.filter((p) => p.alive && p.id !== you.id);
  return (
    <div className="uc-panel">
      <div className="set-status">
        {check ? (
          <span>
            <strong>{state.players.find((p) => p.id === check.target)?.name}</strong> is{" "}
            <strong>{check.isMafia ? "MAFIA" : "not mafia"}</strong>.
          </span>
        ) : (
          <strong>DETECTIVE — choose who to investigate</strong>
        )}
      </div>
      {!check && (
        <div className="opponent-row">
          {targets.map((p) => (
            <button key={p.id} className="opponent" onClick={() => onDetectiveCheck(p.id)}>
              <div className="opponent-name">{p.name}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── DAY ──────────────────────────────────────────────────────────────────
function DayPanel({ state, you, onDayChat, onDayVote }) {
  const [text, setText] = useState("");
  const iAmDead = you && !you.alive;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onDayChat(t);
    setText("");
  };

  return (
    <div className="uc-panel">
      {state.phase === PHASE.DAY_VOTE && (
        <DayVote state={state} you={you} onDayVote={onDayVote} />
      )}

      <div className="mf-chat">
        <div className="mf-chat-list">
          {state.dayChat.slice(-40).map((m, i) => (
            <div key={i} className="mf-chat-row">
              <span className="mf-chat-who">{state.players.find((p) => p.id === m.by)?.name || "?"}</span>
              <span className="mf-chat-text">{m.text}</span>
            </div>
          ))}
        </div>
        {!iAmDead && you && (
          <div className="setup-row">
            <input
              className="text-input"
              placeholder="Say something to the group…"
              value={text}
              maxLength={240}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button className="start-btn" onClick={submit} disabled={!text.trim()}>SEND →</button>
          </div>
        )}
      </div>
    </div>
  );
}

function DayVote({ state, you, onDayVote }) {
  if (!you || !you.alive) {
    const votedCount = Object.keys(state.day.votes).length;
    const aliveCount = state.players.filter((p) => p.alive).length;
    return (
      <div className="set-status">
        <span>Voting in progress — {votedCount}/{aliveCount} cast.{state.day.voteCandidates && " (tie revote)"}</span>
      </div>
    );
  }

  const myVote = state.day.votes[you.id];
  const candidates = state.day.voteCandidates
    ? state.players.filter((p) => state.day.voteCandidates.includes(p.id))
    : state.players.filter((p) => p.alive);

  return (
    <>
      <div className="set-status">
        {myVote ? (
          <span>Vote locked in. Waiting on the rest…</span>
        ) : (
          <strong>VOTE TO LYNCH{state.day.voteCandidates ? " — tie revote" : ""}</strong>
        )}
      </div>
      <div className="opponent-row">
        {candidates.map((p) => (
          <button
            key={p.id}
            className={"opponent" + (myVote === p.id ? " selected" : "")}
            disabled={p.id === you.id && !state.day.voteCandidates?.includes(you.id)}
            onClick={() => onDayVote(p.id)}
          >
            <div className="opponent-name">{p.name}{p.id === you.id && " (you)"}</div>
          </button>
        ))}
        {(!state.day.voteCandidates || state.day.voteCandidates.includes(SKIP)) && (
          <button className={"opponent" + (myVote === SKIP ? " selected" : "")} onClick={() => onDayVote(SKIP)}>
            <div className="opponent-name">NO LYNCH</div>
          </button>
        )}
      </div>
    </>
  );
}

// Only the most recent public event — never a history.
function LastEvent({ state, me }) {
  const nameOf = (id) => (id === me ? "You" : state.players.find((p) => p.id === id)?.name || id);
  const interesting = state.log.filter((e) =>
    ["night_killed", "night_saved", "night_no_kill", "day_lynched", "day_no_lynch", "day_tie_revote", "day_tie_no_elim", "round"].includes(e.kind)
  );
  const e = interesting[interesting.length - 1];
  if (!e) return null;

  let line = null;
  switch (e.kind) {
    case "night_killed":
      line = <><strong>{nameOf(e.who)}</strong> was killed in the night — they were <strong>{ROLE_LABEL[e.role]}</strong>.</>;
      break;
    case "night_saved":
      line = <>The doctor saved <strong>{nameOf(e.who)}</strong> from the mafia.</>;
      break;
    case "night_no_kill":
      line = <>The mafia couldn't agree — no one died last night.</>;
      break;
    case "day_lynched":
      line = <>The town voted out <strong>{nameOf(e.who)}</strong> — they were <strong>{ROLE_LABEL[e.role]}</strong>.</>;
      break;
    case "day_no_lynch":
      line = <>The town chose not to lynch anyone.</>;
      break;
    case "day_tie_revote":
      line = <>Tie vote — revote among the tied suspects.</>;
      break;
    case "day_tie_no_elim":
      line = <>Tie again — no one lynched today.</>;
      break;
    case "round":
      line = <>Night {e.round} falls.</>;
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

// ── GAME OVER ────────────────────────────────────────────────────────────
function GameOver({ state, me, onPlayAgain }) {
  const { winner, players } = state;
  const myRole = players.find((p) => p.id === me)?.role;
  const iWon =
    (winner === "town" && myRole !== ROLE.MAFIA) || (winner === "mafia" && myRole === ROLE.MAFIA);

  return (
    <div className="winner-wrap">
      <div className="champion-banner set-winner">
        <h2>{iWon ? "You won" : "Game over"}</h2>
        <div className="champion-name">{winner === "town" ? "TOWN WINS" : "MAFIA WINS"}</div>
      </div>

      <div className="winner-board">
        <div className="winner-board-title">ROLES REVEALED</div>
        {players.map((p) => (
          <div key={p.id} className={"winner-row" + (p.id === me ? " winner-row-me" : "")}>
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
