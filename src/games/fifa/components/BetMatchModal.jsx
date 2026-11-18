import { useState } from "react";
import { computeMarketNets, resultOutcomeFromScore, poolByOutcome, marketPool } from "../bets";

const CUR_SYM = { INR: "₹", USD: "$", EUR: "€", GBP: "£" };
function money(n, cur) {
  const sym = CUR_SYM[cur] || "";
  const v = Math.abs(Number(n) || 0);
  return `${Number(n) < 0 ? "−" : ""}${sym}${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}
// Bettor identity = normalized typed name; display keeps the raw spelling.
const bettorKey = (name) => String(name || "").trim().toLowerCase().replace(/\s+/g, " ");

// `initial` (a bet being edited) seeds the form; it's keyed by the parent so a
// new `initial` remounts this with fresh state. Because one bettor holds at
// most one bet per market, re-placing for the same bettor overwrites — that IS
// the edit. `onCancelEdit` drops back to a blank form.
function PlaceBet({ market, knownBettors, currency, onPlaceBet, initial, onCancelEdit }) {
  const [name, setName] = useState(initial?.memberName ?? "");
  const [outcomeId, setOutcomeId] = useState(initial?.outcomeId ?? "");
  const [stake, setStake] = useState(initial?.stake != null ? String(initial.stake) : "");
  const editing = !!initial;
  const ready = name.trim() && outcomeId && Number(stake) > 0;

  const submit = () => {
    if (!ready) return;
    onPlaceBet(market.id, {
      memberId: bettorKey(name),
      memberName: name.trim(),
      outcomeId,
      stake: Math.round(Number(stake) * 100) / 100,
    });
    if (editing) onCancelEdit?.();
    else setStake(""); // keep bettor + outcome for quick repeat entry
  };

  return (
    <div className={"bm-place" + (editing ? " editing" : "")}>
      {editing && <div className="bm-place-tag">Editing bet</div>}
      <div className="bm-bettor-row">
        <input
          className="bm-bettor"
          type="text"
          list="bm-bettors"
          placeholder="Bettor name"
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <datalist id="bm-bettors">
          {knownBettors.map((n) => <option key={n} value={n} />)}
        </datalist>
      </div>
      <div className="bm-outcomes">
        {market.outcomes.map((o) => (
          <button
            key={o.id}
            type="button"
            className={"bm-outcome " + (outcomeId === o.id ? "sel" : "")}
            onClick={() => setOutcomeId(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <div className="bm-stakerow">
        <input
          className="bm-stake"
          type="number"
          inputMode="decimal"
          min="0"
          placeholder="Stake"
          value={stake}
          onChange={(e) => setStake(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="bm-place-btn" disabled={!ready} onClick={submit}>
          {editing ? "Save" : "Place"} {Number(stake) > 0 ? money(stake, currency) : "bet"}
        </button>
        {editing && (
          <button type="button" className="bm-place-cancel" onClick={onCancelEdit}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function MarketCard({ market, match, knownBettors, currency, locked, completed, onPlaceBet, onRemoveBet, onSettle }) {
  const pools = poolByOutcome(market.bets);
  const total = marketPool(market.bets);
  const settled = market.settlement;
  const isResult = market.kind === "result";
  const editable = !locked && !completed;
  const [editBet, setEditBet] = useState(null);

  const autoWin = isResult ? resultOutcomeFromScore(match) : null;
  const [winSel, setWinSel] = useState("");
  const winningOutcomeId = isResult ? autoWin : winSel;

  const nameOf = (id) => {
    const b = market.bets.find((x) => String(x.memberId) === String(id));
    return b?.memberName || String(id);
  };
  const preview = completed && winningOutcomeId ? computeMarketNets(market.bets, winningOutcomeId) : [];
  const willVoid = completed && !!winningOutcomeId && preview.length === 0;

  return (
    <div className="bm-market">
      <div className="bm-market-head">
        <span className="bm-market-title">{market.title}</span>
        <span className="bm-market-pool">POOL {money(total, currency)}</span>
      </div>

      <div className="bm-outcome-pools">
        {market.outcomes.map((o) => (
          <div key={o.id} className={"bm-op " + (completed && winningOutcomeId === o.id ? "win" : "")}>
            <span className="bm-op-label">{o.label}</span>
            <span className="bm-op-amt">{money(pools[o.id] || 0, currency)}</span>
          </div>
        ))}
      </div>

      {market.bets.length > 0 && (
        <ul className={"bm-bets" + (editable ? " editable" : "")}>
          {market.bets.map((b) => {
            const o = market.outcomes.find((x) => x.id === b.outcomeId);
            return (
              <li key={b.id} className={editBet?.id === b.id ? "editing" : ""}>
                <span className="bm-bet-who">{b.memberName || nameOf(b.memberId)}</span>
                <span className="bm-bet-on">{o?.label || b.outcomeId}</span>
                <span className="bm-bet-amt">{money(b.stake, currency)}</span>
                {editable && (
                  <span className="bm-bet-actions">
                    <button
                      type="button"
                      className="bm-bet-edit"
                      title="Edit bet"
                      onClick={() => setEditBet(b)}
                    >
                      edit
                    </button>
                    <button
                      type="button"
                      className="bm-bet-del"
                      title="Delete bet"
                      onClick={() => {
                        if (editBet?.id === b.id) setEditBet(null);
                        onRemoveBet(market.id, b.id);
                      }}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {editable && (
        <PlaceBet
          key={editBet?.id || "new"}
          market={market}
          knownBettors={knownBettors}
          currency={currency}
          onPlaceBet={onPlaceBet}
          initial={editBet}
          onCancelEdit={() => setEditBet(null)}
        />
      )}

      {completed && (
        <div className="bm-settle">
          {isResult ? (
            <div className="bm-winrow">
              Result: <strong>{market.outcomes.find((o) => o.id === autoWin)?.label || autoWin}</strong>
            </div>
          ) : !settled?.sent ? (
            <div className="bm-winpick">
              <span>Winning outcome</span>
              {market.outcomes.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  className={"bm-outcome " + (winSel === o.id ? "sel" : "")}
                  onClick={() => setWinSel(o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}

          {settled?.sent ? (
            <div className="bm-done ok">
              <div>✓ Settled — pay up in cash.</div>
              {(settled.transfers || []).length > 0 && (
                <ul className="bm-transfers">
                  {settled.transfers.map((tr, i) => (
                    <li key={i}>
                      <span>{tr.fromName}</span>
                      <span className="muted">pays</span>
                      <span>{tr.toName}</span>
                      <span className="bm-transfer-amt">{money(tr.amount, currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : settled?.void ? (
            <div className="bm-done void">Void — no bets on the other side, nothing owed.</div>
          ) : (
            <>
              {willVoid && <div className="bm-done void">No bets on the other side → nothing to settle.</div>}
              {!willVoid && winningOutcomeId && preview.length > 0 && (
                <ul className="bm-preview">
                  {preview.map((p) => (
                    <li key={p.memberId} className={p.net > 0 ? "pos" : "neg"}>
                      <span>{nameOf(p.memberId)}</span>
                      <span>{money(p.net, currency)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <button
                className="bm-settle-btn"
                disabled={!winningOutcomeId || willVoid}
                onClick={() => onSettle(market, winningOutcomeId)}
              >
                {willVoid ? "Nothing to settle" : "Settle →"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function AddMarket({ onAdd, onCancel }) {
  const [title, setTitle] = useState("");
  const [outcomes, setOutcomes] = useState(["", ""]);
  const setOutcome = (i, v) => setOutcomes((p) => p.map((x, j) => (j === i ? v : x)));
  const cleaned = outcomes.map((o) => o.trim()).filter(Boolean);
  const valid = title.trim() && cleaned.length >= 2;

  return (
    <div className="bm-addform">
      <input
        className="bm-input"
        placeholder="Market title — e.g. Shots on target O/U 4.5"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {outcomes.map((o, i) => (
        <input
          key={i}
          className="bm-input"
          placeholder={`Outcome ${i + 1}`}
          value={o}
          onChange={(e) => setOutcome(i, e.target.value)}
        />
      ))}
      <div className="bm-addbtns">
        <button type="button" className="bm-add ghost" onClick={() => setOutcomes((p) => [...p, ""])}>
          + outcome
        </button>
        <button type="button" className="bm-add" disabled={!valid} onClick={() => onAdd(title.trim(), cleaned)}>
          Create market
        </button>
        <button type="button" className="bm-add ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function BetMatchModal({
  match, matchLabel, markets, kickedOffAt, knownBettors, currency,
  onPlaceBet, onRemoveBet, onAddMarket, onKickOff, onSettle, onClose,
}) {
  const locked = !!kickedOffAt;
  const completed = !!match.completed;
  const [adding, setAdding] = useState(false);

  return (
    <div className="bm-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal">
        <button className="scorer-close" onClick={onClose} aria-label="Close">×</button>
        <div className="bm-header">
          <div className="bm-title">{matchLabel}</div>
          <div className="bm-sub">
            {completed ? "FULL TIME · SETTLE BETS" : locked ? "BETS LOCKED · KICKED OFF" : "BETTING OPEN"}
          </div>
        </div>

        <div className="bm-body">
          {markets.length === 0 && (
            <div className="bm-empty">No markets yet.</div>
          )}
          {markets.map((mk) => (
            <MarketCard
              key={mk.id}
              market={mk}
              match={match}
              knownBettors={knownBettors}
              currency={currency}
              locked={locked}
              completed={completed}
              onPlaceBet={onPlaceBet}
              onRemoveBet={onRemoveBet}
              onSettle={onSettle}
            />
          ))}

          {!locked && !completed && (
            <div className="bm-actions">
              {adding ? (
                <AddMarket
                  onAdd={(t, o) => { onAddMarket(match.id, t, o); setAdding(false); }}
                  onCancel={() => setAdding(false)}
                />
              ) : (
                <button type="button" className="bm-add" onClick={() => setAdding(true)}>
                  + Add custom market
                </button>
              )}
            </div>
          )}
        </div>

        {!locked && !completed && (
          <button
            className="bm-kickoff"
            onClick={() => {
              if (window.confirm("Kick off? This locks every bet on this match.")) onKickOff(match.id);
            }}
          >
            ⚽ KICK OFF — LOCK BETS
          </button>
        )}
      </div>
    </div>
  );
}
