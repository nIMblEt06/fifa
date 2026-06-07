import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import Reactions from "../../components/Reactions";
import { shareUrl, clientId } from "../../utils/room";
import { useRoom } from "../../utils/useRoom";
import {
  TICK_MS, TRACK_LEN, MIN_LANES, MAX_LANES,
  LUNGE_PERIOD_MS, LUNGE_PERFECT, LUNGE_GOOD, HEAT_MAX,
} from "./engine";

// Tap/lunge key pairs for couch seats (multiple chickens on one keyboard).
// A remote player with a single seat can mash any key and lunge with Enter.
const KEY_PAIRS = [
  ["KeyA", "KeyS", "A/S"],
  ["KeyF", "KeyG", "F/G"],
  ["KeyJ", "KeyK", "J/K"],
  ["KeyL", "Semicolon", "L/;"],
  ["KeyV", "KeyB", "V/B"],
  ["KeyN", "KeyM", "N/M"],
];
const CHICKENS = ["🐔", "🐓", "🐤", "🐣", "🦃", "🐦"];

export default function ChickenApp({ code, onLeave }) {
  const me = clientId();

  // ── Server clock sync (ping → pong, best-of RTT) ───────────────────
  const offsetRef = useRef({ offset: 0, bestRtt: Infinity });
  const onMessage = useCallback((msg) => {
    if (msg.type === "chickenPong") {
      const rtt = Date.now() - msg.t;
      if (rtt < offsetRef.current.bestRtt) {
        offsetRef.current = { offset: msg.serverNow + rtt / 2 - Date.now(), bestRtt: rtt };
      }
    }
  }, []);

  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } =
    useRoom(code, { game: "chicken", clientId: me, onMessage });

  const serverNow = useCallback(() => Date.now() + offsetRef.current.offset, []);

  // Ping a few times on connect, then occasionally.
  useEffect(() => {
    if (!connected) return;
    let n = 0;
    const ping = () => sendAction({ type: "chickenPing", t: Date.now() });
    ping();
    const id = setInterval(() => {
      ping();
      if (++n >= 4) clearInterval(id);
    }, 800);
    return () => clearInterval(id);
  }, [connected, sendAction]);

  const phase = view?.phase || "lobby";
  const seats = view?.seats || [];
  const race = view?.race || null;
  const raceStartAt = view?.raceStartAt || null;
  const mySeats = useMemo(() => seats.filter((s) => s.owner === me), [seats, me]);
  const joined = mySeats.length > 0;

  // ── Local tap counting + batched reporting ─────────────────────────
  // Taps are bucketed into 100ms race-time windows locally; every 100ms the
  // last few windows are (re)sent — idempotent by seq, so a dropped frame
  // just gets retried. Nothing is "one message per press".
  const tapBufRef = useRef({});       // seatId -> { seq: count }
  const lungeSentRef = useRef({});    // seatId -> true (per race)
  const raceKeyRef = useRef(null);    // raceStartAt for which buffers are valid

  useEffect(() => {
    if (raceStartAt !== raceKeyRef.current) {
      raceKeyRef.current = raceStartAt;
      tapBufRef.current = {};
      lungeSentRef.current = {};
    }
  }, [raceStartAt]);

  const raceMs = useCallback(
    () => (raceStartAt ? serverNow() - raceStartAt : -1),
    [raceStartAt, serverNow]
  );

  const myLaneFor = useCallback(
    (seatId) => {
      const p = race?.players?.find((x) => x.id === seatId);
      return p ? race.lanes[p.lane] : null;
    },
    [race]
  );

  const recordTap = useCallback(
    (seatId) => {
      if (phase !== "racing") return;
      const ms = raceMs();
      if (ms < 0) return;
      const lane = myLaneFor(seatId);
      if (lane?.finishTick != null) return;
      const seq = Math.floor(ms / TICK_MS);
      const buf = (tapBufRef.current[seatId] = tapBufRef.current[seatId] || {});
      buf[seq] = (buf[seq] || 0) + 1;
    },
    [phase, raceMs, myLaneFor]
  );

  const fireLunge = useCallback(
    (seatId) => {
      if (phase !== "racing") return;
      const lane = myLaneFor(seatId);
      if (!lane || lane.lungeArmedTick == null || lane.lungeUsed || lungeSentRef.current[seatId]) return;
      lungeSentRef.current[seatId] = true;
      sendAction({ type: "chickenLunge", seat: seatId, atMs: raceMs() });
    },
    [phase, myLaneFor, raceMs, sendAction]
  );

  // Batch sender (10Hz while racing).
  useEffect(() => {
    if (phase !== "racing" || mySeats.length === 0) return;
    const id = setInterval(() => {
      const ms = raceMs();
      if (ms < 0) return;
      const cur = Math.floor(ms / TICK_MS);
      const reports = [];
      for (const s of mySeats) {
        const buf = tapBufRef.current[s.id] || {};
        for (let seq = Math.max(0, cur - 4); seq <= cur; seq++) {
          if (buf[seq]) reports.push({ seat: s.id, seq, taps: buf[seq] });
        }
        for (const k of Object.keys(buf)) if (Number(k) < cur - 10) delete buf[k];
      }
      if (reports.length > 0) sendAction({ type: "chickenTaps", reports });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [phase, mySeats, raceMs, sendAction]);

  // Keyboard capture.
  useEffect(() => {
    if (phase !== "racing" || mySeats.length === 0) return;
    const couch = mySeats.length > 1;
    const onKey = (e) => {
      if (e.repeat) return; // auto-repeat is not tapping
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (couch) {
        mySeats.forEach((s, i) => {
          const pair = KEY_PAIRS[i];
          if (!pair) return;
          if (e.code === pair[0]) { e.preventDefault(); recordTap(s.id); }
          else if (e.code === pair[1]) { e.preventDefault(); fireLunge(s.id); }
        });
      } else {
        const seat = mySeats[0];
        if (e.code === "Enter") { e.preventDefault(); fireLunge(seat.id); }
        else if (/^(Key[A-Z]|Digit\d|Space)$/.test(e.code)) { e.preventDefault(); recordTap(seat.id); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, mySeats, recordTap, fireLunge]);

  // Low-rate re-render driver for the countdown + lunge sweep.
  const [, setFrame] = useState(0);
  useEffect(() => {
    if (phase !== "racing") return;
    const id = setInterval(() => setFrame((f) => f + 1), 50);
    return () => clearInterval(id);
  }, [phase]);

  // ── Lobby actions ───────────────────────────────────────────────────
  const [name, setName] = useState("");
  const [couchName, setCouchName] = useState("");

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "chicken")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const countdownMs = raceStartAt ? raceStartAt - serverNow() : 0;
  const counting = phase === "racing" && countdownMs > 0;

  const nameOf = (id) => seats.find((s) => s.id === id)?.name ?? "—";
  const lastEvent = race?.events?.length ? race.events[race.events.length - 1] : null;

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          CHICKEN<span className="slash">/</span>RUN
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {phase !== "lobby" && (
            <button className="room" onClick={() => window.confirm("Back to the lobby?") && sendAction({ type: "chickenReset" })}>
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
      {error && (
        <div className="error-toast" role="alert" onClick={dismissError}>
          <span className="error-toast-msg">{error.message}</span>
          <button className="error-toast-x" aria-label="Dismiss">×</button>
        </div>
      )}

      <main>
        {phase === "lobby" && (
          <div className="setup ck-lobby">
            <h2>The Coop</h2>
            {!joined && (
              <div className="input-row">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && name.trim() && sendAction({ type: "join", name: name.trim() })}
                  placeholder="Your name"
                  maxLength={24}
                />
                <button disabled={!name.trim()} onClick={() => sendAction({ type: "join", name: name.trim() })}>
                  Join
                </button>
              </div>
            )}

            <ol className="player-list">
              {seats.map((s, i) => (
                <li key={s.id}>
                  <span className="ck-bird">{CHICKENS[i % CHICKENS.length]}</span> {s.name}
                  {s.owner === me && <span className="muted"> (you{s.id !== me ? "rs" : ""})</span>}
                  {mySeats.length > 1 && s.owner === me && (
                    <span className="ck-keys">{KEY_PAIRS[mySeats.findIndex((x) => x.id === s.id)]?.[2]}</span>
                  )}
                  {s.owner === me && (
                    <button className="remove-btn" onClick={() => sendAction({ type: "chickenRemoveSeat", seat: s.id })} aria-label={`Remove ${s.name}`}>
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <div className="player-count">{seats.length}/{MAX_LANES} chickens</div>

            {joined && seats.length < MAX_LANES && (
              <div className="input-row ck-couch">
                <input
                  value={couchName}
                  onChange={(e) => setCouchName(e.target.value)}
                  placeholder="+ couch player (same keyboard)"
                  maxLength={24}
                />
                <button
                  disabled={!couchName.trim()}
                  onClick={() => { sendAction({ type: "chickenAddCouch", name: couchName.trim() }); setCouchName(""); }}
                >
                  Add
                </button>
              </div>
            )}

            <div className="ck-rules muted">
              Mash to run. Redline past ~12 taps/s and you <strong>faceplant</strong>. Trailing birds draft.
              Mud slows, worms boost. Cross 90% to arm the <strong>LUNGE</strong> — one perfectly timed press wins photo finishes.
              {mySeats.length <= 1 ? " Solo seat: mash any key, Enter to lunge." : " Couch keys shown above (tap/lunge)."}
            </div>

            <button className="start-btn" disabled={!joined || seats.length < MIN_LANES} onClick={() => sendAction({ type: "chickenStart" })}>
              Race! →
            </button>
            {seats.length < MIN_LANES && <div className="muted" style={{ marginTop: "0.5rem" }}>Need at least {MIN_LANES} chickens.</div>}
          </div>
        )}

        {(phase === "racing" || phase === "results") && race && (
          <div className="ck-race">
            {counting && (
              <div className="ck-countdown" key={Math.ceil(countdownMs / 1000)}>
                {Math.ceil(countdownMs / 1000)}
              </div>
            )}
            {!counting && phase === "racing" && countdownMs > -1200 && <div className="ck-countdown ck-go">GO!</div>}

            <Track race={race} seats={seats} me={me} />

            {/* Lunge bars for my armed lanes */}
            {phase === "racing" &&
              mySeats.map((s) => {
                const lane = myLaneFor(s.id);
                if (!lane || lane.lungeArmedTick == null || lane.lungeUsed || lane.finishTick != null) return null;
                const armedMs = lane.lungeArmedTick * TICK_MS;
                const phase01 = (((raceMs() - armedMs) % LUNGE_PERIOD_MS) + LUNGE_PERIOD_MS) % LUNGE_PERIOD_MS / LUNGE_PERIOD_MS;
                return (
                  <div className="ck-lunge" key={s.id}>
                    <div className="ck-lunge-label">
                      {s.name} — LUNGE! {mySeats.length > 1 ? `(${KEY_PAIRS[mySeats.findIndex((x) => x.id === s.id)]?.[2]?.split("/")[1]})` : "(Enter)"}
                    </div>
                    <div className="ck-lunge-bar" onTouchStart={(e) => { e.preventDefault(); fireLunge(s.id); }}>
                      <div className="ck-lunge-zone good" style={{ left: `${(0.5 - LUNGE_GOOD) * 100}%`, width: `${LUNGE_GOOD * 200}%` }} />
                      <div className="ck-lunge-zone perfect" style={{ left: `${(0.5 - LUNGE_PERFECT) * 100}%`, width: `${LUNGE_PERFECT * 200}%` }} />
                      <div className="ck-lunge-needle" style={{ left: `${phase01 * 100}%` }} />
                    </div>
                  </div>
                );
              })}

            {/* Touch controls */}
            {phase === "racing" && !counting && mySeats.length > 0 && (
              <div className="ck-touch">
                {mySeats.map((s) => (
                  <button
                    key={s.id}
                    className="ck-tap-btn"
                    onTouchStart={(e) => { e.preventDefault(); recordTap(s.id); }}
                    onMouseDown={(e) => { e.preventDefault(); recordTap(s.id); }}
                  >
                    TAP {mySeats.length > 1 ? `· ${s.name}` : ""}
                  </button>
                ))}
              </div>
            )}

            {lastEvent && phase === "racing" && (
              <div className="activity-log">
                <div className="activity-log-title">TRACKSIDE</div>
                <ul className="activity-log-list">
                  <li className="log-row"><EventLine e={lastEvent} nameOf={nameOf} /></li>
                </ul>
              </div>
            )}

            {phase === "results" && race.results && (
              <div className="winner-wrap">
                <div className="champion-banner set-winner">
                  <h2>Winner</h2>
                  <div className="champion-name">{nameOf(race.results[0].id)}</div>
                  <div className="champion-team">
                    {race.results[0].finishTick != null
                      ? `${(race.results[0].finishTick * TICK_MS / 1000).toFixed(2)}s of furious pecking`
                      : "nobody finished — disgraceful"}
                  </div>
                </div>
                <div className="winner-board">
                  <div className="winner-board-title">PHOTO FINISH</div>
                  {race.results.map((r, i) => (
                    <div key={r.id} className={"winner-row" + (i === 0 ? " winner-row-top" : "") + (seats.find((s) => s.id === r.id)?.owner === me ? " winner-row-me" : "")}>
                      <span className="winner-rank">{i + 1}</span>
                      <span className="winner-name">{CHICKENS[r.lane % CHICKENS.length]} {r.name}</span>
                      <span className="winner-sets">
                        {r.finishTick != null ? `${(r.finishTick * TICK_MS / 1000).toFixed(2)}s` : `DNF · ${Math.round((r.pos / TRACK_LEN) * 100)}%`}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="winner-cta">
                  <button className="start-btn" onClick={() => sendAction({ type: "chickenRematch" })}>REMATCH →</button>
                  <button className="poker-btn" style={{ marginLeft: "0.6rem" }} onClick={() => sendAction({ type: "chickenReset" })}>
                    Back to coop
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── Track rendering ───────────────────────────────────────────────────
function Track({ race, seats, me }) {
  return (
    <div className="ck-track">
      {race.players.map((p) => {
        const lane = race.lanes[p.lane];
        const trackLane = race.track.lanes[p.lane];
        const pct = (lane.pos / race.track.len) * 100;
        const mine = seats.find((s) => s.id === p.id)?.owner === me;
        return (
          <div key={p.id} className={"ck-lane" + (mine ? " is-mine" : "")}>
            <div className="ck-lane-head">
              <span className="ck-lane-name">
                {p.name}
                {lane.finishTick != null && <span className="ck-flag"> 🏁</span>}
              </span>
              <div className="ck-heat" title="Heat — redline and you trip">
                <div
                  className={"ck-heat-fill" + (lane.heat > 70 ? " hot" : "")}
                  style={{ width: `${(lane.heat / HEAT_MAX) * 100}%` }}
                />
              </div>
            </div>
            <div className="ck-strip">
              {trackLane.mud.map((m, i) => (
                <div key={`m${i}`} className="ck-mud" style={{ left: `${(m.at / race.track.len) * 100}%`, width: `${(m.len / race.track.len) * 100}%` }} />
              ))}
              {trackLane.worms.map((w) =>
                lane.wormsEaten.includes(w) ? null : (
                  <span key={`w${w}`} className="ck-worm" style={{ left: `${(w / race.track.len) * 100}%` }}>🪱</span>
                )
              )}
              <div className="ck-lungezone" />
              <span
                className={
                  "ck-chicken" +
                  (lane.tripped ? " tripped" : "") +
                  (lane.boosted ? " boosted" : "") +
                  (lane.lungeResult === "perfect" || lane.lungeResult === "good" ? " lunging" : "")
                }
                style={{ left: `min(${pct}%, calc(100% - 28px))` }}
              >
                {lane.tripped ? "💫" : CHICKENS[p.lane % CHICKENS.length]}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EventLine({ e, nameOf }) {
  switch (e.kind) {
    case "trip": return <><strong>{nameOf(e.who)}</strong> overheated and FACEPLANTED 💫</>;
    case "worm": return <><strong>{nameOf(e.who)}</strong> gobbled a worm — turbo! 🪱</>;
    case "lunge_armed": return <><strong>{nameOf(e.who)}</strong> is in the lunge zone…</>;
    case "lunge":
      return e.result === "stumble"
        ? <><strong>{nameOf(e.who)}</strong> mistimed the lunge and STUMBLED</>
        : <><strong>{nameOf(e.who)}</strong> hit a {e.result.toUpperCase()} lunge!</>;
    case "finish": return <><strong>{nameOf(e.who)}</strong> crosses the line! 🏁</>;
    case "race_over": return <>Race over.</>;
    default: return null;
  }
}
