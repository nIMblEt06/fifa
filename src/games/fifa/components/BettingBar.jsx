import { useState } from "react";

// Header + currency control for FIFA match betting. Payouts are pari-mutuel
// and settle in-app — hand over the cash in person. The ledger syncs with the
// room blob, so everyone sees the same bets.
const CURRENCIES = ["INR", "USD", "EUR", "GBP"];
const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };

const STATUS_TEXT = { needs: "SETTLE", done: "SETTLED", void: "NO PAYOUT", locked: "LOCKED", open: "OPEN" };

export default function BettingBar({ currency, onSetCurrency, ledger, onOpenMatch }) {
  const [showLedger, setShowLedger] = useState(false);

  const rows = ledger || [];
  const needsCount = rows.filter((r) => r.status === "needs").length;
  const sym = CUR_SYM[currency] || "";

  return (
    <div className="fifa-bet-bar">
      <div className="fifa-bet-bar-head">
        <div className="fifa-bet-label">MATCH BETTING</div>
        <span className="fifa-bet-note">Parimutuel pools — payouts settle in cash.</span>
        <label className="fifa-bet-cur">
          CURRENCY
          <select value={currency} onChange={(e) => onSetCurrency(e.target.value)}>
            {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      {rows.length > 0 && (
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
