import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Reactions from "../../components/Reactions";
import { shareUrl, clientId } from "../../utils/room";
import { useRoom } from "../../utils/useRoom";
import { computeNets, imbalance, isBalanced, computeSettlement, moneyPerChip } from "./money";
import MemberCombobox from "../../components/MemberCombobox";

const SUIT_GLYPH = { S: "♠", H: "♥", D: "♦", C: "♣" };
const firstName = (name) => (name || "").toLowerCase().trim().split(/\s+/)[0] || "";
const todayIso = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

const fmt = (n, cur = "INR") => {
  const sym = cur === "INR" ? "₹" : "";
  const v = Math.abs(Number(n) || 0);
  return `${n < 0 ? "−" : ""}${sym}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const chipsFmt = (n) => (Number(n) || 0).toLocaleString();

// Pull a one-shot ?sw=… marker out of the URL hash (the OAuth callback
// bounces back to #/r/CODE/poker?sw=connected) and scrub it.
function takeSwFlag() {
  const m = window.location.hash.match(/[?&]sw=([a-z]+)/);
  if (!m) return null;
  const cleaned = window.location.hash.replace(/[?&]sw=[a-z]+/, "");
  window.history.replaceState(null, "", window.location.pathname + cleaned);
  return m[1];
}

export default function PokerApp({ code, onLeave }) {
  const me = clientId();
  const { state: view, presence, reactions, connected, error, dismissError, sendAction, sendReaction } =
    useRoom(code, { game: "poker", clientId: me });

  // Server-authoritative snapshot (v2). Anything else (fresh room → null,
  // pre-rewrite client blob) renders the lobby; the first join upgrades the
  // room server-side.
  const isV2 = !!view && view.gameType === "poker" && "table" in view;
  const phase = isV2 ? view.phase : "lobby";
  const config = isV2 ? view.config : { ratio: { chips: 5000, money: 250 }, sb: 25, bb: 50, currency: "INR" };
  const sw = (isV2 && view.splitwise) || { connected: false };
  const currency = config.currency || "INR";
  const mpc = moneyPerChip(config.ratio);

  const [swFlag, setSwFlag] = useState(() => takeSwFlag());
  useEffect(() => {
    if (!swFlag) return;
    const id = setTimeout(() => setSwFlag(null), 5000);
    return () => clearTimeout(id);
  }, [swFlag]);

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "poker")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  const resetAll = () => {
    if (!window.confirm("Back to the lobby? Stacks and buy-ins will be wiped.")) return;
    sendAction({ type: "pokerReset" });
  };
  const pressTimer = useRef(null);
  const onMastPressStart = () => { pressTimer.current = setTimeout(resetAll, 1200); };
  const onMastPressEnd = () => { if (pressTimer.current) clearTimeout(pressTimer.current); };

  return (
    <div className="app">
      <header className="masthead">
        <h1
          onMouseDown={onMastPressStart}
          onMouseUp={onMastPressEnd}
          onMouseLeave={onMastPressEnd}
          onTouchStart={onMastPressStart}
          onTouchEnd={onMastPressEnd}
          title="Long-press to reset"
        >
          POKER<span className="slash">/</span>HOLD&apos;EM
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
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

      {swFlag && (
        <div className={"poker-sw-flag " + (swFlag === "connected" ? "ok" : "bad")}>
          {swFlag === "connected" && "✓ Splitwise connected"}
          {swFlag === "denied" && "Splitwise access was denied"}
          {swFlag === "expired" && "Splitwise login expired — try again"}
          {swFlag === "error" && "Splitwise connection failed — try again"}
        </div>
      )}

      <main>
        {phase === "lobby" && (
          <Lobby code={code} me={me} view={isV2 ? view : null} sw={sw} config={config}
                 currency={currency} sendAction={sendAction} />
        )}
        {phase === "playing" && isV2 && view.table && (
          <Table me={me} view={view} mpc={mpc} currency={currency} sendAction={sendAction} />
        )}
        {phase === "results" && isV2 && view.table && (
          <Results code={code} view={view} mpc={mpc} currency={currency} sendAction={sendAction} />
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}

// ── LOBBY ───────────────────────────────────────────────────────────
function Lobby({ code, me, view, sw, config, currency, sendAction }) {
  const lobby = view?.lobby || [];
  const joined = lobby.some((p) => p.id === me);
  const members = sw.members || null;

  const [name, setName] = useState("");
  const [memberId, setMemberId] = useState("");

  // Picking a Splitwise member fills the name; clearing keeps the typed name.
  const pickMember = (val) => {
    setMemberId(val);
    const m = members?.find((x) => String(x.id) === String(val));
    if (m) setName(m.name);
  };

  const join = () => {
    const n = name.trim();
    if (!n) return;
    sendAction({ type: "join", name: n, memberId: memberId || null });
  };

  // Group picker
  const [groups, setGroups] = useState(null);
  const [groupsError, setGroupsError] = useState(null);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [pickingGroup, setPickingGroup] = useState(false);
  const needsGroup = sw.connected && !sw.groupId;

  const loadGroups = useCallback(async () => {
    setLoadingGroups(true);
    setGroupsError(null);
    try {
      const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/groups`);
      const data = await res.json();
      if (!res.ok) setGroupsError(data?.error || `Failed (${res.status})`);
      else setGroups(data);
    } catch (e) {
      setGroupsError(`Could not reach the server: ${e.message}`);
    } finally {
      setLoadingGroups(false);
    }
  }, [code]);

  useEffect(() => {
    if ((needsGroup || pickingGroup) && !groups && !loadingGroups && !groupsError) loadGroups();
  }, [needsGroup, pickingGroup, groups, loadingGroups, groupsError, loadGroups]);

  const pickGroup = async (groupId) => {
    try {
      const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId }),
      });
      const data = await res.json();
      if (!res.ok) setGroupsError(data?.error || `Failed (${res.status})`);
      else setPickingGroup(false);
    } catch (e) {
      setGroupsError(`Could not reach the server: ${e.message}`);
    }
  };

  // Config (host-less: anyone in the lobby can tweak)
  const setConfig = (patch) => sendAction({ type: "pokerConfig", ...patch });
  const ratio = config.ratio;

  return (
    <div className="setup poker-lobby">
      <h2>Lobby</h2>

      {/* ── Splitwise connection ─────────────────────────────── */}
      <div className="poker-sw">
        <div className="label">SPLITWISE</div>
        {!sw.connected && (
          <div className="poker-sw-connect">
            <div className="poker-ratio-note">
              Whoever runs the books connects their Splitwise — the game settles into one of their groups.
            </div>
            <a className="start-btn poker-sw-btn" href={`/api/splitwise/auth/start?room=${code.toLowerCase()}`}>
              CONNECT SPLITWISE →
            </a>
          </div>
        )}
        {sw.connected && (
          <div className="poker-sw-status">
            <span className="poker-sw-who">
              ✓ {sw.via === "env" ? "house account" : sw.userName || "connected"}
            </span>
            {sw.groupId && !pickingGroup ? (
              <span className="poker-sw-group">
                → <strong>{sw.groupName || `group #${sw.groupId}`}</strong>
                {sw.members ? ` · ${sw.members.length} members` : ""}
                <button className="poker-btn poker-sw-change" onClick={() => { setPickingGroup(true); setGroups(null); }}>
                  change
                </button>
              </span>
            ) : (
              <div className="poker-sw-groups">
                {loadingGroups && <span className="poker-ratio-note">Loading your groups…</span>}
                {groupsError && (
                  <span className="poker-warn">
                    {groupsError}{" "}
                    <button className="poker-btn" onClick={loadGroups}>Retry</button>
                  </span>
                )}
                {groups && groups.length === 0 && <span className="poker-ratio-note">No groups on this account.</span>}
                {groups &&
                  groups.map((g) => (
                    <button key={g.id} className="poker-btn poker-sw-grouppick" onClick={() => pickGroup(g.id)}>
                      {g.name} <span className="muted">· {g.memberCount}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Take a seat ──────────────────────────────────────── */}
      <div className="label" style={{ marginTop: "1.25rem" }}>TAKE A SEAT</div>
      {members && (
        <div className="poker-map-row">
          <span className="player-label">Splitwise member</span>
          <MemberCombobox members={members} value={memberId} onChange={pickMember} />
        </div>
      )}
      <div className="input-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && join()}
          placeholder={members ? "…or type a name (guest)" : "Your name"}
          maxLength={24}
        />
        <button onClick={join} disabled={!name.trim()}>{joined ? "Update" : "Join"}</button>
      </div>

      <ol className="player-list">
        {lobby.map((p) => (
          <li key={p.id}>
            {p.name}
            {p.memberId && <span className="poker-sw-tag" title="Mapped to Splitwise">sw</span>}
            {p.id === me && <span className="muted"> (you)</span>}
            {p.id === me && (
              <button className="remove-btn" onClick={() => sendAction({ type: "pokerLeave" })} aria-label="Leave">
                ×
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="player-count">{lobby.length} players</div>

      {/* ── Stakes ───────────────────────────────────────────── */}
      <div className="poker-ratio">
        <div className="label">STAKES</div>
        <div className="poker-ratio-row">
          <input type="number" min="1" value={ratio.chips}
                 onChange={(e) => setConfig({ ratio: { chips: e.target.value, money: ratio.money } })} />
          <span>chips =</span>
          <span className="poker-cur">₹</span>
          <input type="number" min="0" value={ratio.money}
                 onChange={(e) => setConfig({ ratio: { chips: ratio.chips, money: e.target.value } })} />
        </div>
        <div className="poker-ratio-row poker-blinds-row">
          <span>blinds</span>
          <input type="number" min="1" value={config.sb} onChange={(e) => setConfig({ sb: e.target.value })} />
          <span>/</span>
          <input type="number" min="1" value={config.bb} onChange={(e) => setConfig({ bb: e.target.value })} />
          <span className="muted">chips</span>
        </div>
        <div className="poker-ratio-note">
          Stack = {chipsFmt(ratio.chips)} chips = {fmt(ratio.money, currency)} · blinds {chipsFmt(config.sb)}/{chipsFmt(config.bb)}
        </div>
      </div>

      <button className="start-btn" disabled={!joined || lobby.length < 2}
              onClick={() => sendAction({ type: "pokerStart" })}>
        Shuffle Up &amp; Deal →
      </button>
      {lobby.length < 2 && <div className="muted" style={{ marginTop: "0.5rem" }}>Need at least 2 players.</div>}
    </div>
  );
}

// ── TABLE ───────────────────────────────────────────────────────────
function Table({ me, view, mpc, currency, sendAction }) {
  const t = view.table;
  const h = t.hand;
  const seats = t.seats;
  const meSeat = seats.find((s) => s.id === me);
  const handLive = h && !h.results;
  const myTurn = handLive && h.toAct === me;

  const nameOf = (id) =>
    seats.find((s) => s.id === id)?.name ?? t.cashedOut.find((s) => s.id === id)?.name ?? "—";

  const owe = handLive ? Math.max(0, (h.currentBet || 0) - (h.committed[me] || 0)) : 0;
  const myMax = meSeat ? (h?.committed[me] || 0) + meSeat.stack : 0;

  // Default the raise-to input to the min raise whenever the action comes
  // around to us (adjust-state-during-render, same idiom as LitApp).
  const [raiseTo, setRaiseTo] = useState("");
  const [raiseKey, setRaiseKey] = useState(null);
  const curRaiseKey = myTurn ? `${t.handNo}:${h.street}:${h.currentBet}` : null;
  if (curRaiseKey !== raiseKey) {
    setRaiseKey(curRaiseKey);
    if (curRaiseKey) setRaiseTo(String(Math.min(h.minRaiseTo, myMax)));
  }

  const act = (move, amount) => sendAction({ type: "pokerAction", move, amount });

  const [rebuyOpen, setRebuyOpen] = useState(false);
  const [rebuyChips, setRebuyChips] = useState("");

  // Last public action for the status strip.
  const lastAction = useMemo(() => {
    const log = view.table.log || [];
    for (let i = log.length - 1; i >= 0; i--) {
      const e = log[i];
      if (["fold", "check", "call", "bet", "raise", "win_fold", "showdown", "street"].includes(e.kind)) return e;
    }
    return null;
  }, [view.table.log]);

  return (
    <div className="poker-game">
      <div className="label">
        HAND #{t.handNo}
        <span className="label-num">
          blinds {chipsFmt(t.sb)}/{chipsFmt(t.bb)} · {fmt(mpc, currency)}/chip
        </span>
      </div>

      {/* Board + pot */}
      <div className="poker-felt">
        <div className="poker-board">
          {(h?.board || []).map((c) => <PlayingCard key={c} card={c} />)}
          {h && h.board.length === 0 && h.street === "preflop" && <span className="poker-street-tag">PREFLOP</span>}
          {!h && <span className="poker-street-tag">WAITING</span>}
        </div>
        {h && (
          <div className="poker-pot">
            POT <strong>{chipsFmt(h.pot)}</strong>
            <span className="poker-row-money"> {fmt(h.pot * mpc, currency)}</span>
          </div>
        )}
      </div>

      {/* Last-hand results banner */}
      {h?.results && (
        <div className="poker-handresult">
          {h.results.pots.map((p, i) => (
            <div key={i} className="poker-handresult-row">
              <strong>{p.winners.map(nameOf).join(" & ")}</strong>
              <span> win{p.winners.length === 1 ? "s" : ""} {chipsFmt(p.amount)}</span>
              {p.hand && <span className="poker-handname"> · {p.hand}</span>}
            </div>
          ))}
          {Object.keys(h.results.revealed || {}).length > 0 && (
            <div className="poker-revealed">
              {Object.entries(h.results.revealed).map(([pid, cards]) => (
                <span key={pid} className="poker-revealed-one">
                  {nameOf(pid)}: {cards.map((c) => <MiniCard key={c} card={c} />)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Seats */}
      <div className="poker-table">
        {seats.map((s) => {
          const isTurn = handLive && h.toAct === s.id;
          return (
            <div key={s.id}
                 className={"poker-row poker-seat" +
                   (isTurn ? " is-turn" : "") +
                   (handLive && h.folded[s.id] ? " is-folded" : "") +
                   (s.sittingOut ? " is-out" : "")}>
              <div className="poker-row-name">
                {t.buttonId === s.id && <span className="poker-dealer" title="Dealer button">D</span>}
                {s.name}
                {s.id === me && <span className="muted"> (you)</span>}
              </div>
              <div className="poker-row-totals">
                <strong>{chipsFmt(s.stack)}</strong>
                <span className="poker-row-money">{fmt(s.stack * mpc, currency)}</span>
                <span className="muted">{s.buyInCount}×buy-in</span>
                {s.pendingChips > 0 && <span className="poker-pending">+{chipsFmt(s.pendingChips)} next hand</span>}
              </div>
              <div className="poker-seat-state">
                {handLive && (h.committed[s.id] || 0) > 0 && (
                  <span className="poker-bet-chip">{chipsFmt(h.committed[s.id])}</span>
                )}
                {handLive && h.allIn[s.id] && !h.folded[s.id] && <span className="poker-badge allin">ALL-IN</span>}
                {handLive && h.folded[s.id] && <span className="poker-badge">FOLDED</span>}
                {s.sittingOut && <span className="poker-badge">SITTING OUT</span>}
                {isTurn && s.id !== me && (
                  <button className="poker-btn poker-ghostfold"
                          title="Only works if their connection dropped"
                          onClick={() => sendAction({ type: "pokerAction", move: owePlayer(h, s.id) > 0 ? "fold" : "check", forId: s.id })}>
                    away? {owePlayer(h, s.id) > 0 ? "fold" : "check"} for them
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Your cards + action bar */}
      {meSeat && h && (
        <div className="poker-you">
          <div className="poker-hole">
            {(h.yourHole || []).map((c) => <PlayingCard key={c} card={c} big />)}
            {!h.yourHole && <span className="muted">not dealt in</span>}
          </div>

          {myTurn && (
            <div className="poker-actionbar">
              <button className="poker-btn poker-act-fold" onClick={() => act("fold")}>FOLD</button>
              {owe === 0 ? (
                <button className="poker-btn poker-act-check" onClick={() => act("check")}>CHECK</button>
              ) : (
                <button className="poker-btn poker-act-call" onClick={() => act("call")}>
                  CALL {chipsFmt(Math.min(owe, meSeat.stack))}
                </button>
              )}
              {myMax > h.currentBet && (
                <span className="poker-raise">
                  <input type="number" min={h.minRaiseTo} max={myMax} value={raiseTo}
                         onChange={(e) => setRaiseTo(e.target.value)} />
                  <button className="poker-btn poker-act-raise" onClick={() => act("raise", Number(raiseTo))}>
                    {h.currentBet === 0 ? "BET" : "RAISE TO"} {chipsFmt(Number(raiseTo) || 0)}
                  </button>
                  <button className="poker-btn" onClick={() => setRaiseTo(String(Math.min(h.minRaiseTo, myMax)))}>min</button>
                  <button className="poker-btn" onClick={() => setRaiseTo(String(Math.min(h.pot * 2 + h.currentBet, myMax)))}>pot</button>
                  <button className="poker-btn" onClick={() => setRaiseTo(String(myMax))}>all-in</button>
                </span>
              )}
            </div>
          )}
          {handLive && !myTurn && h.toAct && (
            <div className="poker-waiting muted">Waiting on {nameOf(h.toAct)}…</div>
          )}
        </div>
      )}

      {/* Last action strip */}
      {lastAction && (
        <div className="activity-log">
          <div className="activity-log-title">LAST ACTION</div>
          <ul className="activity-log-list">
            <li className="log-row"><LastAction e={lastAction} nameOf={nameOf} me={me} /></li>
          </ul>
        </div>
      )}

      {/* Session controls */}
      <div className="poker-buttons" style={{ marginTop: "1rem" }}>
        {h?.results && (
          <button className="start-btn" onClick={() => sendAction({ type: "pokerNextHand" })}>
            Next Hand →
          </button>
        )}
        {meSeat && (
          <>
            <button className="poker-btn" onClick={() => setRebuyOpen((v) => !v)}>+ Rebuy</button>
            <button className="poker-btn" onClick={() => sendAction({ type: "pokerSitOut", out: !meSeat.sittingOut })}>
              {meSeat.sittingOut ? "Sit In" : "Sit Out"}
            </button>
            <button className="poker-btn poker-btn-undo"
                    onClick={() => window.confirm("Cash out and leave the table?") && sendAction({ type: "pokerCashOut" })}>
              Cash Out
            </button>
          </>
        )}
        {(!h || h.results) && (
          <button className="poker-btn poker-btn-undo" onClick={() => sendAction({ type: "pokerEndSession" })}>
            End Session →
          </button>
        )}
      </div>

      {rebuyOpen && meSeat && (
        <div className="poker-rebuy">
          <button className="poker-btn"
                  onClick={() => { sendAction({ type: "pokerRebuy", chips: view.config.ratio.chips }); setRebuyOpen(false); }}>
            + Stack ({chipsFmt(view.config.ratio.chips)})
          </button>
          <input type="number" min="1" placeholder="custom chips" value={rebuyChips}
                 onChange={(e) => setRebuyChips(e.target.value)} />
          <button className="poker-btn"
                  onClick={() => { if (Number(rebuyChips) > 0) { sendAction({ type: "pokerRebuy", chips: Number(rebuyChips) }); setRebuyChips(""); setRebuyOpen(false); } }}>
            + Add
          </button>
          <span className="poker-ratio-note">Rebuys land when the current hand ends.</span>
        </div>
      )}
    </div>
  );
}

function owePlayer(h, id) {
  return Math.max(0, (h.currentBet || 0) - (h.committed[id] || 0));
}

function LastAction({ e, nameOf, me }) {
  const who = (id) => (id === me ? "You" : nameOf(id));
  switch (e.kind) {
    case "fold": return <><strong>{who(e.who)}</strong> folded</>;
    case "check": return <><strong>{who(e.who)}</strong> checked</>;
    case "call": return <><strong>{who(e.who)}</strong> called {chipsFmt(e.chips)}{e.allIn ? " — ALL-IN" : ""}</>;
    case "bet": return <><strong>{who(e.who)}</strong> bet {chipsFmt(e.to)}{e.allIn ? " — ALL-IN" : ""}</>;
    case "raise": return <><strong>{who(e.who)}</strong> raised to {chipsFmt(e.to)}{e.allIn ? " — ALL-IN" : ""}</>;
    case "street": return <>{e.street.toUpperCase()} — {e.board.join(" ")}</>;
    case "win_fold": return <><strong>{who(e.who)}</strong> takes {chipsFmt(e.chips)} — everyone folded</>;
    case "showdown":
      return <>{e.pots.map((p, i) => (
        <span key={i}>{p.winners.map(who).join(" & ")} win{p.winners.length === 1 ? "s" : ""} {chipsFmt(p.amount)} ({p.hand}){i < e.pots.length - 1 ? " · " : ""}</span>
      ))}</>;
    default: return null;
  }
}

// ── RESULTS / SETTLEMENT ────────────────────────────────────────────
function Results({ code, view, mpc, currency, sendAction }) {
  const t = view.table;
  const sw = view.splitwise || { connected: false };
  const members = sw.members || null;

  // Settlement rows: live seats (stack + queued rebuys) + cashed-out seats.
  const rows = useMemo(() => {
    const out = [];
    for (const s of t.cashedOut) {
      out.push({
        id: s.id, name: s.name, memberId: s.memberId,
        buyInChips: (s.buyIns || []).reduce((a, b) => a + b, 0),
        finalChips: s.finalChips,
      });
    }
    for (const s of t.seats) {
      out.push({
        id: s.id, name: s.name, memberId: s.memberId,
        buyInChips: s.buyInChips,
        finalChips: s.stack + (s.pendingChips || 0),
      });
    }
    return out;
  }, [t]);

  const nets = useMemo(() => computeNets(rows, view.config.ratio), [rows, view.config.ratio]);
  const imb = useMemo(() => imbalance(nets), [nets]);
  const balanced = isBalanced(nets, Math.max(1, mpc));
  const transfers = useMemo(() => computeSettlement(nets), [nets]);

  // Splitwise mapping: seed from seat memberIds, then first-name match.
  const [mapping, setMapping] = useState({});
  useEffect(() => {
    setMapping((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        if (next[r.id]) continue;
        if (r.memberId) { next[r.id] = String(r.memberId); continue; }
        const match = members && members.find((m) => firstName(m.name) === firstName(r.name));
        next[r.id] = match ? String(match.id) : "";
      }
      return next;
    });
  }, [rows, members]);

  const [settling, setSettling] = useState(false);
  const [settleStatus, setSettleStatus] = useState(null);

  const settle = async () => {
    const participants = [];
    for (const n of nets) {
      if (Math.abs(n.net) < 0.005) continue;
      const userId = mapping[n.id];
      if (!userId) {
        setSettleStatus({ error: `${n.name} is not mapped to a Splitwise member.` });
        return;
      }
      participants.push({ userId, net: n.net });
    }
    if (participants.length === 0) {
      setSettleStatus({ error: "Nothing to settle — everyone is even." });
      return;
    }
    setSettling(true);
    setSettleStatus(null);
    const date = todayIso();
    try {
      const res = await fetch(`/api/room/${code.toLowerCase()}/splitwise/settle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ description: date, currency, date, participants }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) setSettleStatus({ error: data?.error || `Failed (${res.status})` });
      else setSettleStatus({ ok: true, expenseId: data.expenseId, cost: data.cost, date });
    } catch (e) {
      setSettleStatus({ error: `Could not reach the server: ${e.message}` });
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="poker-results">
      <div className="label">
        NET RESULTS
        <span className="label-num">{fmt(mpc, currency)}/chip · {t.handNo} hands</span>
      </div>

      {!balanced && (
        <div className="poker-warn">
          ⚠ Nets don&apos;t sum to zero — off by {fmt(imb, currency)}. (Rounding from the chip ratio.)
        </div>
      )}

      <table className="poker-net-table">
        <thead>
          <tr>
            <th>Player</th>
            <th>Buy-in</th>
            <th>Final</th>
            <th>Net chips</th>
            <th>Net</th>
          </tr>
        </thead>
        <tbody>
          {nets.map((n) => (
            <tr key={n.id}>
              <td>{n.name}</td>
              <td>{chipsFmt(n.buyInChips)}</td>
              <td>{chipsFmt(n.finalChips)}</td>
              <td className={n.netChips < 0 ? "neg" : n.netChips > 0 ? "pos" : ""}>
                {n.netChips > 0 ? "+" : ""}{chipsFmt(n.netChips)}
              </td>
              <td className={n.net < 0 ? "neg" : n.net > 0 ? "pos" : ""}>{fmt(n.net, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="label" style={{ marginTop: "1.5rem" }}>WHO PAYS WHOM</div>
      {transfers.length === 0 ? (
        <div className="poker-even">Everyone&apos;s even — nothing to settle.</div>
      ) : (
        <ul className="poker-transfers">
          {transfers.map((tr, i) => (
            <li key={i}>
              <span className="poker-debtor">{tr.fromName}</span>
              <span className="poker-arrow">→</span>
              <span className="poker-creditor">{tr.toName}</span>
              <span className="poker-amount">{fmt(tr.amount, currency)}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="label" style={{ marginTop: "1.5rem" }}>SETTLE TO SPLITWISE</div>
      <div className="poker-splitwise">
        {!sw.connected && (
          <div className="poker-warn">
            Splitwise isn&apos;t connected for this room.
            <a className="poker-btn" style={{ marginLeft: "0.6rem" }}
               href={`/api/splitwise/auth/start?room=${code.toLowerCase()}`}>
              Connect →
            </a>
          </div>
        )}
        {sw.connected && !sw.groupId && (
          <div className="poker-warn">No group selected — pick one from the lobby.</div>
        )}
        {sw.connected && sw.groupId && (
          <>
            <div className="poker-ratio-note">
              Group: <strong>{sw.groupName || `#${sw.groupId}`}</strong>
              {sw.via === "env" ? " (house account)" : sw.userName ? ` · via ${sw.userName}` : ""}
            </div>
            {members && (
              <div className="poker-map">
                {rows.map((r) => (
                  <div className="poker-map-row" key={r.id}>
                    <span className="player-label">{r.name}</span>
                    <MemberCombobox
                      members={members}
                      value={mapping[r.id] ?? ""}
                      onChange={(val) => setMapping((m) => ({ ...m, [r.id]: val }))}
                    />
                  </div>
                ))}
              </div>
            )}
            <button className="start-btn" onClick={settle} disabled={settling || transfers.length === 0}>
              {settling ? "Settling…" : "Settle to Splitwise →"}
            </button>
          </>
        )}
        {settleStatus?.error && <div className="poker-warn">{settleStatus.error}</div>}
        {settleStatus?.ok && (
          <div className="poker-even">
            ✓ Splitwise expense created{settleStatus.expenseId ? ` (#${settleStatus.expenseId})` : ""} — {fmt(settleStatus.cost, currency)} on {settleStatus.date}.
          </div>
        )}
      </div>

      <div className="poker-buttons" style={{ marginTop: "1.5rem" }}>
        <button className="poker-btn" onClick={() => sendAction({ type: "pokerResume" })}>
          ← Back to the table
        </button>
        <button className="poker-btn" onClick={() => sendAction({ type: "pokerReset" })}>
          New session (same players)
        </button>
      </div>
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────
function PlayingCard({ card, big }) {
  const rank = card[0];
  const suit = card[1];
  const glyph = SUIT_GLYPH[suit];
  const red = suit === "H" || suit === "D";
  return (
    <div className={"pcard" + (red ? " red" : "") + (big ? " pcard-big" : "")}>
      <span className="pcard-corner tl">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{glyph}</span>
      </span>
      <span className="pcard-center">{glyph}</span>
      <span className="pcard-corner br">
        <span className="pcard-rank">{rank}</span>
        <span className="pcard-suit">{glyph}</span>
      </span>
    </div>
  );
}

function MiniCard({ card }) {
  const red = card[1] === "H" || card[1] === "D";
  return (
    <span className={"poker-minicard" + (red ? " red" : "")}>
      {card[0]}{SUIT_GLYPH[card[1]]}
    </span>
  );
}
