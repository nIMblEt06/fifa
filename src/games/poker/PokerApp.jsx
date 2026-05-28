import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Reactions from "../../components/Reactions";
import { shareUrl } from "../../utils/room";
import { useRoom } from "../../utils/useRoom";
import { computeNets, imbalance, isBalanced, computeSettlement, moneyPerChip } from "./money";
import MemberCombobox from "./MemberCombobox";

const firstName = (name) => (name || "").toLowerCase().trim().split(/\s+/)[0] || "";
const todayIso = () => {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
};

// ── State shape (client-authoritative blob, relayed verbatim) ───────────
//   {
//     gameType: "poker",
//     phase: "lobby" | "session" | "cashout" | "results",
//     ratio: { chips, money },        // chip↔money: `chips` chips == `money` INR
//     currency: "INR",
//     players: [{ id, name, buyIns: [chips,…], finalChips: number|null }],
//   }
const PHASES = { LOBBY: "lobby", SESSION: "session", CASHOUT: "cashout", RESULTS: "results" };

function emptyState() {
  return {
    gameType: "poker",
    phase: PHASES.LOBBY,
    ratio: { chips: 5000, money: 250 },
    currency: "INR",
    players: [],
  };
}

function pid() {
  return `p_${Math.random().toString(36).slice(2, 9)}`;
}

const fmt = (n, cur = "INR") => {
  const sym = cur === "INR" ? "₹" : "";
  const v = Math.abs(Number(n) || 0);
  return `${n < 0 ? "−" : ""}${sym}${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function PokerApp({ code, onLeave }) {
  const { state: remoteState, presence, reactions, sendState, sendReaction, connected } = useRoom(code, { game: "poker" });

  const state = remoteState ?? emptyState();
  const { phase, ratio, currency, players } = state;

  const update = useCallback(
    (patch) => {
      const next = typeof patch === "function" ? patch(state) : { ...state, ...patch };
      sendState(next);
    },
    [state, sendState]
  );

  // Players augmented with buy-in totals for display & math.
  const withTotals = useMemo(
    () =>
      players.map((p) => ({
        ...p,
        buyInChips: (p.buyIns || []).reduce((s, x) => s + (Number(x) || 0), 0),
      })),
    [players]
  );

  const mpc = moneyPerChip(ratio);
  const standardStack = ratio.chips;

  // ── Lobby ──────────────────────────────────────────────────────────
  const [nameInput, setNameInput] = useState("");
  const addPlayer = () => {
    const name = nameInput.trim();
    if (!name) return;
    update((prev) => ({
      ...prev,
      players: [...prev.players, { id: pid(), name, buyIns: [], finalChips: null }],
    }));
    setNameInput("");
  };
  const removePlayer = (id) =>
    update((prev) => ({ ...prev, players: prev.players.filter((p) => p.id !== id) }));

  const setRatio = (key, val) => {
    const n = Math.max(0, Number(val) || 0);
    update((prev) => ({ ...prev, ratio: { ...prev.ratio, [key]: n } }));
  };

  const startSession = () => {
    if (players.length < 2) return;
    // Everyone starts with one standard buy-in.
    update((prev) => ({
      ...prev,
      phase: PHASES.SESSION,
      players: prev.players.map((p) => ({ ...p, buyIns: [prev.ratio.chips], finalChips: null })),
    }));
  };

  // ── Session ────────────────────────────────────────────────────────
  const [customChips, setCustomChips] = useState({}); // id -> string
  const addBuyIn = (id, chips) => {
    const c = Number(chips) || 0;
    if (c <= 0) return;
    update((prev) => ({
      ...prev,
      players: prev.players.map((p) => (p.id === id ? { ...p, buyIns: [...(p.buyIns || []), c] } : p)),
    }));
  };
  const undoBuyIn = (id) =>
    update((prev) => ({
      ...prev,
      players: prev.players.map((p) =>
        p.id === id ? { ...p, buyIns: (p.buyIns || []).slice(0, -1) } : p
      ),
    }));

  const toCashout = () => update({ phase: PHASES.CASHOUT });

  // ── Cashout ────────────────────────────────────────────────────────
  const setFinalChips = (id, val) => {
    const n = val === "" ? null : Math.max(0, Number(val) || 0);
    update((prev) => ({
      ...prev,
      players: prev.players.map((p) => (p.id === id ? { ...p, finalChips: n } : p)),
    }));
  };
  const allCashedOut = withTotals.every((p) => p.finalChips !== null && p.finalChips !== undefined);
  const toResults = () => {
    if (!allCashedOut) return;
    update({ phase: PHASES.RESULTS });
  };

  // ── Results / settlement math ──────────────────────────────────────
  const nets = useMemo(
    () =>
      computeNets(
        withTotals.map((p) => ({
          id: p.id,
          name: p.name,
          buyInChips: p.buyInChips,
          finalChips: Number(p.finalChips) || 0,
        })),
        ratio
      ),
    [withTotals, ratio]
  );
  const imb = useMemo(() => imbalance(nets), [nets]);
  const balanced = isBalanced(nets, Math.max(1, mpc)); // tolerance ~ one chip
  const transfers = useMemo(() => computeSettlement(nets), [nets]);

  // ── Reset ──────────────────────────────────────────────────────────
  const resetAll = () => {
    if (!window.confirm("Wipe this session and start a new one?")) return;
    update(emptyState());
  };
  const newSessionSamePlayers = () => {
    update((prev) => ({
      ...prev,
      phase: PHASES.LOBBY,
      players: prev.players.map((p) => ({ ...p, buyIns: [], finalChips: null })),
    }));
    setSettleStatus(null);
  };

  const pressTimer = useRef(null);
  const onMastPressStart = () => { pressTimer.current = setTimeout(resetAll, 1200); };
  const onMastPressEnd = () => { if (pressTimer.current) clearTimeout(pressTimer.current); };

  const [copied, setCopied] = useState(false);
  const copyLink = () => {
    navigator.clipboard?.writeText(shareUrl(code, "poker")).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  // ── Splitwise ──────────────────────────────────────────────────────
  const [members, setMembers] = useState(null); // [{id,name}] | null
  const [swError, setSwError] = useState(null);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [mapping, setMapping] = useState({}); // pokerPlayerId -> splitwiseUserId|""
  const [settling, setSettling] = useState(false);
  const [settleStatus, setSettleStatus] = useState(null); // {results} | {error}

  const loadMembers = useCallback(async () => {
    setLoadingMembers(true);
    setSwError(null);
    try {
      const res = await fetch("/api/splitwise/group");
      const data = await res.json();
      if (!res.ok) {
        setSwError(data?.error || `Failed (${res.status})`);
        setMembers(null);
      } else {
        setMembers(data);
      }
    } catch (e) {
      setSwError(`Could not reach the server: ${e.message}`);
    } finally {
      setLoadingMembers(false);
    }
  }, []);

  // Fetch members automatically as soon as the room enters RESULTS — no extra click.
  useEffect(() => {
    if (phase === PHASES.RESULTS && !members && !loadingMembers && !swError) {
      loadMembers();
    }
  }, [phase, members, loadingMembers, swError, loadMembers]);

  // Auto-suggest mapping by first-name match when members load.
  useEffect(() => {
    if (!members) return;
    setMapping((prev) => {
      const next = { ...prev };
      for (const p of players) {
        if (next[p.id]) continue;
        const pFirst = firstName(p.name);
        const match = pFirst && members.find((m) => firstName(m.name) === pFirst);
        next[p.id] = match ? String(match.id) : "";
      }
      return next;
    });
  }, [members, players]);

  const settle = async () => {
    // Build one expense covering everyone's net: winners "paid" their winnings,
    // losers "owe" their losses. Sums of paid_share and owed_share both equal the pot.
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
      const res = await fetch("/api/splitwise/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: date,
          currency: currency || "INR",
          date,
          participants,
        }),
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
          POKER<span className="slash">/</span>CASH GAME
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
            {copied ? "LINK COPIED" : `ROOM ${code}`}
          </button>
        </div>
      </header>

      {!connected && <div className="conn-state">RECONNECTING…</div>}

      <main>
        {/* ── LOBBY ────────────────────────────────────────────── */}
        {phase === PHASES.LOBBY && (
          <div className="setup poker-lobby">
            <h2>Buy-in</h2>

            <div className="input-row">
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPlayer()}
                placeholder="Player name"
                maxLength={24}
              />
              <button onClick={addPlayer}>Add</button>
            </div>

            <ol className="player-list">
              {players.map((p) => (
                <li key={p.id}>
                  {p.name}
                  <button className="remove-btn" onClick={() => removePlayer(p.id)} aria-label={`Remove ${p.name}`}>
                    ×
                  </button>
                </li>
              ))}
            </ol>
            <div className="player-count">{players.length} players</div>

            <div className="poker-ratio">
              <div className="label">CHIP RATIO</div>
              <div className="poker-ratio-row">
                <input
                  type="number"
                  min="1"
                  value={ratio.chips}
                  onChange={(e) => setRatio("chips", e.target.value)}
                />
                <span>chips =</span>
                <span className="poker-cur">₹</span>
                <input
                  type="number"
                  min="0"
                  value={ratio.money}
                  onChange={(e) => setRatio("money", e.target.value)}
                />
              </div>
              <div className="poker-ratio-note">
                One standard stack = {standardStack.toLocaleString()} chips = {fmt(ratio.money, currency)} · {fmt(mpc, currency)}/chip
              </div>
            </div>

            <button className="start-btn" disabled={players.length < 2} onClick={startSession}>
              Start Session →
            </button>
          </div>
        )}

        {/* ── SESSION ──────────────────────────────────────────── */}
        {phase === PHASES.SESSION && (
          <div className="poker-session">
            <div className="label">
              SESSION
              <span className="label-num">{withTotals.length} players</span>
            </div>
            <div className="poker-table">
              {withTotals.map((p) => (
                <div className="poker-row" key={p.id}>
                  <div className="poker-row-name">{p.name}</div>
                  <div className="poker-row-totals">
                    <span>{(p.buyIns || []).length} buy-in{(p.buyIns || []).length === 1 ? "" : "s"}</span>
                    <strong>{p.buyInChips.toLocaleString()} chips</strong>
                    <span className="poker-row-money">{fmt(p.buyInChips * mpc, currency)}</span>
                  </div>
                  <div className="poker-row-actions">
                    <button className="poker-btn" onClick={() => addBuyIn(p.id, standardStack)}>
                      + Stack ({standardStack.toLocaleString()})
                    </button>
                    <input
                      type="number"
                      min="1"
                      placeholder="custom"
                      value={customChips[p.id] ?? ""}
                      onChange={(e) => setCustomChips((m) => ({ ...m, [p.id]: e.target.value }))}
                    />
                    <button
                      className="poker-btn"
                      onClick={() => {
                        addBuyIn(p.id, customChips[p.id]);
                        setCustomChips((m) => ({ ...m, [p.id]: "" }));
                      }}
                    >
                      + Add
                    </button>
                    {(p.buyIns || []).length > 0 && (
                      <button className="poker-btn poker-btn-undo" onClick={() => undoBuyIn(p.id)}>
                        Undo
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            <button className="start-btn" onClick={toCashout}>
              End &amp; Cash Out →
            </button>
          </div>
        )}

        {/* ── CASHOUT ──────────────────────────────────────────── */}
        {phase === PHASES.CASHOUT && (
          <div className="poker-session">
            <div className="label">
              CASH OUT
              <span className="label-num">final chip counts</span>
            </div>
            <div className="poker-table">
              {withTotals.map((p) => (
                <div className="poker-row" key={p.id}>
                  <div className="poker-row-name">{p.name}</div>
                  <div className="poker-row-totals">
                    <span>bought in</span>
                    <strong>{p.buyInChips.toLocaleString()} chips</strong>
                  </div>
                  <div className="poker-row-actions">
                    <input
                      type="number"
                      min="0"
                      placeholder="final chips"
                      value={p.finalChips ?? ""}
                      onChange={(e) => setFinalChips(p.id, e.target.value)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="poker-buttons">
              <button className="poker-btn" onClick={() => update({ phase: PHASES.SESSION })}>
                ← Back
              </button>
              <button className="start-btn" disabled={!allCashedOut} onClick={toResults}>
                Results →
              </button>
            </div>
          </div>
        )}

        {/* ── RESULTS ──────────────────────────────────────────── */}
        {phase === PHASES.RESULTS && (
          <div className="poker-results">
            <div className="label">
              NET RESULTS
              <span className="label-num">{fmt(mpc, currency)}/chip</span>
            </div>

            {!balanced && (
              <div className="poker-warn">
                ⚠ Nets don&apos;t sum to zero — off by {fmt(imb, currency)}. Re-check the final chip counts.
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
                    <td>{n.buyInChips.toLocaleString()}</td>
                    <td>{n.finalChips.toLocaleString()}</td>
                    <td className={n.netChips < 0 ? "neg" : n.netChips > 0 ? "pos" : ""}>
                      {n.netChips > 0 ? "+" : ""}
                      {n.netChips.toLocaleString()}
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
                {transfers.map((t, i) => (
                  <li key={i}>
                    <span className="poker-debtor">{t.fromName}</span>
                    <span className="poker-arrow">→</span>
                    <span className="poker-creditor">{t.toName}</span>
                    <span className="poker-amount">{fmt(t.amount, currency)}</span>
                  </li>
                ))}
              </ul>
            )}

            {/* ── Splitwise settlement ─────────────────────────── */}
            <div className="label" style={{ marginTop: "1.5rem" }}>SETTLE TO SPLITWISE</div>
            <div className="poker-splitwise">
              {!members && loadingMembers && (
                <div className="poker-ratio-note">Loading Splitwise members…</div>
              )}
              {swError && (
                <div className="poker-warn">
                  {swError}
                  <div className="poker-ratio-note" style={{ marginTop: "0.5rem" }}>
                    Set <code>SPLITWISE_TOKEN</code> and <code>SPLITWISE_GROUP_ID</code> Worker secrets
                    (<code>wrangler secret put SPLITWISE_TOKEN</code>). See src/games/poker/SPLITWISE.md.
                  </div>
                  <button className="poker-btn" style={{ marginTop: "0.6rem" }} onClick={loadMembers} disabled={loadingMembers}>
                    {loadingMembers ? "Retrying…" : "Retry"}
                  </button>
                </div>
              )}

              {members && (
                <>
                  <div className="poker-map">
                    {players.map((p) => (
                      <div className="poker-map-row" key={p.id}>
                        <span className="player-label">{p.name}</span>
                        <MemberCombobox
                          members={members}
                          value={mapping[p.id] ?? ""}
                          onChange={(val) => setMapping((m) => ({ ...m, [p.id]: val }))}
                        />
                      </div>
                    ))}
                  </div>
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
              <button className="poker-btn" onClick={() => update({ phase: PHASES.CASHOUT })}>
                ← Edit cash-out
              </button>
              <button className="poker-btn" onClick={newSessionSamePlayers}>
                New session (same players)
              </button>
              <button className="poker-btn poker-btn-undo" onClick={resetAll}>
                Reset everything
              </button>
            </div>
          </div>
        )}
      </main>

      <Reactions reactions={reactions} onSend={sendReaction} />
    </div>
  );
}
