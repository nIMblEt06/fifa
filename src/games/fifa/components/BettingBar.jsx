import { useState, useEffect, useCallback } from "react";

// Connect / group / currency control for FIFA match betting. Reachable in any
// phase so people can wire up Splitwise mid-tournament. The OAuth link carries
// game=fifa so the callback bounces back to the FIFA room. Group selection and
// connection status flow to every client via the room's `splitwise` broadcast
// (handled in FifaApp), so this component just kicks off the fetches.
const CURRENCIES = ["INR", "USD", "EUR", "GBP"];
const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

const STATUS_TEXT = { needs: "SETTLE", done: "SETTLED", void: "NO PAYOUT", locked: "LOCKED", open: "OPEN" };

export default function BettingBar({ code, sw, currency, onSetCurrency, ledger, onOpenMatch }) {
  const lc = code.toLowerCase();
  const connected = !!sw?.connected;
  const groupId = sw?.groupId;

  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showLedger, setShowLedger] = useState(false);

  const rows = ledger || [];
  const needsCount = rows.filter((r) => r.status === "needs").length;
  const sym = CUR_SYM[currency] || "";

  const needsGroup = connected && !groupId;

  const loadGroups = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/room/${lc}/splitwise/groups`);
      const data = await res.json();
      if (!res.ok) setError(data?.error || `Failed (${res.status})`);
      else setGroups(data);
    } catch (e) {
      setError(`Could not reach the server: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [lc]);

  useEffect(() => {
    if ((needsGroup || picking) && !groups && !loading && !error) loadGroups();
  }, [needsGroup, picking, groups, loading, error, loadGroups]);

  const pickGroup = async (gid) => {
    setError(null);
    try {
      const res = await fetch(`/api/room/${lc}/splitwise/group`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: gid }),
      });
      const data = await res.json();
      if (!res.ok) setError(data?.error || `Failed (${res.status})`);
      else setPicking(false);
    } catch (e) {
      setError(`Could not reach the server: ${e.message}`);
    }
  };

  return (
    <div className="fifa-bet-bar">
      <div className="fifa-bet-label">MATCH BETTING · SPLITWISE</div>

      {!connected && (
        <div className="fifa-bet-connect">
          <span className="fifa-bet-note">
            Connect Splitwise to let anyone bet on matches — payouts settle into one of your groups.
          </span>
          <a className="start-btn fifa-bet-btn" href={`/api/splitwise/auth/start?room=${lc}&game=fifa`}>
            CONNECT SPLITWISE →
          </a>
        </div>
      )}

      {connected && (
        <div className="fifa-bet-status">
          <span className="fifa-bet-who">
            ✓ {sw.via === "env" ? "house account" : sw.userName || "connected"}
          </span>

          {groupId && !picking ? (
            <>
              <span className="fifa-bet-group">
                → <strong>{sw.groupName || `group #${groupId}`}</strong>
                {sw.members ? ` · ${sw.members.length} members` : ""}
                <button className="fifa-bet-change" onClick={() => { setPicking(true); setGroups(null); }}>
                  change
                </button>
              </span>
              <label className="fifa-bet-cur">
                CURRENCY
                <select value={currency} onChange={(e) => onSetCurrency(e.target.value)}>
                  {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </>
          ) : (
            <div className="fifa-bet-groups">
              {loading && <span className="fifa-bet-note">Loading your groups…</span>}
              {error && (
                <span className="fifa-bet-warn">
                  {error} <button onClick={loadGroups}>Retry</button>
                </span>
              )}
              {groups && groups.length === 0 && <span className="fifa-bet-note">No groups on this account.</span>}
              {groups && groups.map((g) => (
                <button key={g.id} className="fifa-bet-grouppick" onClick={() => pickGroup(g.id)}>
                  {g.name} <span className="muted">· {g.memberCount}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {connected && groupId && rows.length > 0 && (
        <div className="fifa-bet-ledger">
          <button
            type="button"
            className="fifa-bet-ledger-toggle"
            aria-expanded={showLedger}
            onClick={() => setShowLedger((v) => !v)}
          >
            <span className="caret">{showLedger ? "▾" : "▸"}</span>
            ALL BETS <span className="muted">· {rows.length}</span>
            {needsCount > 0 && <span className="fifa-bet-badge">{needsCount} TO SETTLE</span>}
          </button>

          {showLedger && (
            <ul className="fifa-bet-ledger-list">
              {rows.map((r) => (
                <li key={r.matchId}>
                  <button
                    type="button"
                    className={"fifa-bet-row " + r.status}
                    onClick={() => onOpenMatch?.(r.matchId)}
                  >
                    <span className="fbr-dot" aria-hidden />
                    <span className="fbr-label">{r.label}</span>
                    <span className="fbr-pool">{sym}{r.pool.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
                    <span className="fbr-tag">{STATUS_TEXT[r.status]}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
