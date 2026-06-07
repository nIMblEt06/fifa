// Pure Texas Hold'em engine for the poker cash game. No React, no I/O.
//
// Like the Lit engine, this module is pure (same input → same output, RNG
// injectable) and is loaded by BOTH the Cloudflare Durable Object
// (authoritative — deals cards, validates every action) and the client
// (constants + helpers only; clients never see the deck).
//
// Money model: the table runs on CHIPS. The chip↔money ratio and the
// Splitwise settlement live outside the engine (money.js + RoomDO) — the
// engine only guarantees chips are conserved: sum(stacks) + pot stays equal
// to sum(buy-ins) of everyone dealt in.
//
// Rules implemented:
//   • No-limit Texas Hold'em cash game, 2–9 seats.
//   • Blinds posted from sb/bb config; heads-up the button posts the SB and
//     acts first preflop, last postflop.
//   • Raise-to semantics: `amount` is the total a player's street bet becomes.
//     Min-raise = currentBet + lastRaiseSize. A short all-in (less than a
//     full raise) does NOT reopen betting for players who already acted.
//   • Side pots: built from per-player total commitments at showdown; folded
//     players' dead money stays in the layer it was committed to. Odd chips
//     go to the earliest eligible seat left of the button.
//   • Showdown: best 5-of-7 evaluation; ties split. When everyone is all-in
//     the remaining streets run out and all live hands are revealed.
//   • Rebuys (addChips) queue while a hand is in progress and land when it
//     completes, so mid-hand stacks are never mutated from outside.

export const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
export const SUITS = ["S", "H", "D", "C"];
export const STREETS = ["preflop", "flop", "turn", "river"];
export const MAX_SEATS = 9;

export const HAND_NAMES = [
  "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
  "Flush", "Full House", "Four of a Kind", "Straight Flush",
];

// rank char → numeric value (2..14, ace high)
const RANK_VALUE = Object.fromEntries(RANKS.map((r, i) => [r, i + 2]));

export function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  return deck;
}

export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ── Hand evaluation ──────────────────────────────────────────────────
// score5: 5 cards → comparable integer. Category in the high digits, then
// five tiebreak ranks packed base-15. Bigger = better.

function score5(cards) {
  const vals = cards.map((c) => RANK_VALUE[c[0]]).sort((a, b) => b - a);
  const suits = cards.map((c) => c[1]);
  const flush = suits.every((s) => s === suits[0]);

  // Straight detection (ace can play low: A-5-4-3-2).
  let straightHigh = 0;
  const uniq = [...new Set(vals)];
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5 && uniq[1] - uniq[4] === 3) straightHigh = 5; // wheel
  }

  // Rank multiplicity, sorted by (count desc, value desc).
  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  let cat;
  if (straightHigh && flush) cat = 8;
  else if (groups[0][1] === 4) cat = 7;
  else if (groups[0][1] === 3 && groups[1][1] === 2) cat = 6;
  else if (flush) cat = 5;
  else if (straightHigh) cat = 4;
  else if (groups[0][1] === 3) cat = 3;
  else if (groups[0][1] === 2 && groups[1][1] === 2) cat = 2;
  else if (groups[0][1] === 2) cat = 1;
  else cat = 0;

  // Tiebreak digits: straights compare on the high card only; everything
  // else on group values in (count desc, value desc) order.
  let digits;
  if (cat === 4 || cat === 8) digits = [straightHigh, 0, 0, 0, 0];
  else {
    digits = groups.map(([v]) => v);
    while (digits.length < 5) digits.push(0);
  }

  let score = cat;
  for (const d of digits.slice(0, 5)) score = score * 15 + d;
  return score;
}

// Best 5-card score from 5/6/7 cards.
export function evaluate(cards) {
  let best = -1;
  const n = cards.length;
  if (n === 5) return score5(cards);
  // all C(n,5) combos
  const combo = (start, picked) => {
    if (picked.length === 5) {
      const s = score5(picked.map((i) => cards[i]));
      if (s > best) best = s;
      return;
    }
    for (let i = start; i < n; i++) combo(i + 1, [...picked, i]);
  };
  combo(0, []);
  return best;
}

export function handCategory(score) {
  // Invert the packing: category is the leading base-15^5 digit.
  return Math.floor(score / 15 ** 5);
}

export function describeScore(score) {
  return HAND_NAMES[handCategory(score)] || "—";
}

// ── Table lifecycle ──────────────────────────────────────────────────

// Create a table from lobby players. Everyone buys in for `startingStack`
// chips (one standard stack).
//   players: [{ id, name, memberId? }]
export function createTable(players, config) {
  const { sb, bb, startingStack } = config;
  if (players.length < 2) throw new Error("Need at least 2 players");
  if (players.length > MAX_SEATS) throw new Error(`Max ${MAX_SEATS} players`);
  if (!(sb > 0) || !(bb > 0) || bb < sb) throw new Error("Invalid blinds");
  if (!(startingStack >= bb * 2)) throw new Error("Starting stack too small for the blinds");
  return {
    seats: players.map((p) => ({
      id: p.id,
      name: p.name,
      memberId: p.memberId ?? null,
      stack: startingStack,
      buyIns: [startingStack],
      pendingChips: 0,
      sittingOut: false,
    })),
    cashedOut: [],            // seats that left mid-session, frozen for settlement
    sb,
    bb,
    buttonIdx: 0,
    handNo: 0,
    hand: null,
    log: [],
  };
}

function liveSeats(table) {
  return table.seats.filter((s) => !s.sittingOut && s.stack > 0);
}

export function canStartHand(table) {
  return (!table.hand || !!table.hand.results) && liveSeats(table).length >= 2;
}

// Deal the next hand: rotate button, post blinds, deal hole cards. A
// completed hand (results set) stays attached for display until the next
// deal replaces it.
export function startHand(table, rng = Math.random) {
  if (table.hand && !table.hand.results) return { error: "Hand already in progress" };
  const t = structuredClone(table);
  t.hand = null;

  // Land queued rebuys before dealing.
  for (const s of t.seats) {
    if (s.pendingChips > 0) {
      s.stack += s.pendingChips;
      s.pendingChips = 0;
    }
  }

  const live = liveSeats(t);
  if (live.length < 2) return { error: "Need at least 2 players with chips" };

  // Rotate button to the next live seat (first hand keeps buttonIdx if live).
  if (t.handNo > 0 || t.seats[t.buttonIdx]?.sittingOut || !(t.seats[t.buttonIdx]?.stack > 0)) {
    t.buttonIdx = nextLiveIdx(t, t.buttonIdx);
  }

  const order = dealOrder(t); // live seat ids, starting left of button
  const headsUp = order.length === 2;

  const deck = shuffle(freshDeck(), rng);
  const holes = {};
  for (const id of order) holes[id] = [deck.pop(), deck.pop()];

  // Blinds. Heads-up: button = SB, other = BB.
  const sbId = headsUp ? seatId(t, t.buttonIdx) : order[0];
  const bbId = headsUp ? order.find((id) => id !== sbId) : order[1];

  const hand = {
    deck,
    holes,
    board: [],
    street: "preflop",
    dealtIn: order,
    folded: {},
    allIn: {},
    committed: {},
    totalCommitted: {},
    pot: 0,
    currentBet: 0,
    lastRaiseSize: t.bb,
    actedSinceFullRaise: {},
    pending: [],
    toAct: null,
    results: null,
  };
  t.hand = hand;
  t.handNo += 1;

  post(t, sbId, Math.min(t.sb, stackOf(t, sbId)));
  post(t, bbId, Math.min(t.bb, stackOf(t, bbId)));
  hand.currentBet = t.bb;

  // Preflop action starts left of the BB (heads-up that's the SB/button,
  // because deal order is [BB, button] and we wrap past the BB).
  hand.pending = pendingFrom(t, nextLiveInHand(t, bbId));
  advanceIfSettled(t);

  t.log.push({ t: Date.now(), kind: "hand_start", handNo: t.handNo, sb: sbId, bb: bbId, button: seatId(t, t.buttonIdx) });
  return { table: t };
}

function seatId(table, idx) {
  return table.seats[idx]?.id;
}

function seatById(table, id) {
  return table.seats.find((s) => s.id === id);
}

function stackOf(table, id) {
  return seatById(table, id)?.stack ?? 0;
}

function nextLiveIdx(table, fromIdx) {
  const n = table.seats.length;
  for (let k = 1; k <= n; k++) {
    const i = (fromIdx + k) % n;
    const s = table.seats[i];
    if (!s.sittingOut && s.stack > 0) return i;
  }
  return fromIdx;
}

// Live seat ids in deal order (left of button first, button last).
function dealOrder(table) {
  const out = [];
  const n = table.seats.length;
  for (let k = 1; k <= n; k++) {
    const s = table.seats[(table.buttonIdx + k) % n];
    if (!s.sittingOut && s.stack > 0) out.push(s.id);
  }
  return out;
}

// Move chips from a stack into the pot for the current street.
function post(table, id, chips) {
  const seat = seatById(table, id);
  const h = table.hand;
  const pay = Math.min(chips, seat.stack);
  seat.stack -= pay;
  h.committed[id] = (h.committed[id] || 0) + pay;
  h.totalCommitted[id] = (h.totalCommitted[id] || 0) + pay;
  h.pot += pay;
  if (seat.stack === 0) h.allIn[id] = true;
}

// Players still in the hand (not folded).
function inHand(table) {
  return table.hand.dealtIn.filter((id) => !table.hand.folded[id]);
}

// Players who can still act (in hand, not all-in).
function canAct(table) {
  return inHand(table).filter((id) => !table.hand.allIn[id]);
}

// Next player after `id` (in deal order) who can act.
function nextLiveInHand(table, id) {
  const order = table.hand.dealtIn;
  const i = order.indexOf(id);
  for (let k = 1; k <= order.length; k++) {
    const cand = order[(i + k) % order.length];
    if (!table.hand.folded[cand] && !table.hand.allIn[cand]) return cand;
  }
  return null;
}

// Build the pending-action queue starting from `firstId` (deal order).
function pendingFrom(table, firstId) {
  if (!firstId) return [];
  const order = table.hand.dealtIn;
  const start = order.indexOf(firstId);
  const out = [];
  for (let k = 0; k < order.length; k++) {
    const id = order[(start + k) % order.length];
    if (!table.hand.folded[id] && !table.hand.allIn[id]) out.push(id);
  }
  return out;
}

// ── Player actions ───────────────────────────────────────────────────
// applyAction(table, playerId, { move, amount }) → { table, error? }
//   move: "fold" | "check" | "call" | "bet" | "raise"
//   amount: raise-to / bet-to total for this street (chips)

export function applyAction(table, playerId, action) {
  const h = table.hand;
  if (!h || h.results) return { error: "No hand in progress" };
  if (h.toAct !== playerId) return { error: "Not your turn" };
  const move = action?.move;
  const t = structuredClone(table);
  const th = t.hand;
  const myCommitted = th.committed[playerId] || 0;
  const myStack = stackOf(t, playerId);
  const owe = th.currentBet - myCommitted;

  if (move === "fold") {
    th.folded[playerId] = true;
    t.log.push({ t: Date.now(), kind: "fold", who: playerId, street: th.street });
    th.pending = th.pending.filter((id) => id !== playerId);
  } else if (move === "check") {
    if (owe > 0) return { error: "Can't check — there's a bet to you" };
    t.log.push({ t: Date.now(), kind: "check", who: playerId, street: th.street });
    th.pending = th.pending.filter((id) => id !== playerId);
  } else if (move === "call") {
    if (owe <= 0) return { error: "Nothing to call — check instead" };
    post(t, playerId, Math.min(owe, myStack));
    t.log.push({ t: Date.now(), kind: "call", who: playerId, chips: Math.min(owe, myStack), street: th.street, allIn: !!th.allIn[playerId] });
    th.pending = th.pending.filter((id) => id !== playerId);
  } else if (move === "bet" || move === "raise") {
    const to = Math.floor(Number(action.amount) || 0);
    const maxTo = myCommitted + myStack;
    if (to > maxTo) return { error: "Not enough chips" };
    if (to <= th.currentBet) return { error: "Raise must exceed the current bet" };
    const isAllIn = to === maxTo;
    const minTo = th.currentBet === 0 ? Math.max(t.bb, 1) : th.currentBet + th.lastRaiseSize;
    if (to < minTo && !isAllIn) return { error: `Minimum ${th.currentBet === 0 ? "bet" : "raise"} is ${minTo}` };
    if (th.currentBet > 0 && th.actedSinceFullRaise[playerId]) {
      return { error: "You can't re-raise — the all-in didn't reopen betting" };
    }
    const wasBet = th.currentBet === 0;
    const raiseSize = to - th.currentBet;
    const fullRaise = raiseSize >= th.lastRaiseSize || wasBet;
    post(t, playerId, to - myCommitted);
    th.currentBet = to;
    if (fullRaise) {
      th.lastRaiseSize = raiseSize;
      // A full raise reopens the action: everyone may raise again.
      th.actedSinceFullRaise = {};
    }
    t.log.push({ t: Date.now(), kind: wasBet ? "bet" : "raise", who: playerId, to, street: th.street, allIn: isAllIn });
    // Everyone else still in gets to respond. After a short all-in they
    // re-enter the queue but may only call/fold (actedSinceFullRaise gate).
    th.pending = pendingFrom(t, nextLiveInHand(t, playerId)).filter((id) => id !== playerId);
  } else {
    return { error: "Unknown move" };
  }

  if (move !== "fold") th.actedSinceFullRaise[playerId] = true;

  advanceIfSettled(t);
  return { table: t };
}

// Street settlement: when the pending queue is empty, advance the street,
// run out the board if everyone is all-in, or finish the hand.
function advanceIfSettled(table) {
  const h = table.hand;

  // Hand over by folds?
  const live = inHand(table);
  if (live.length === 1) {
    finishByFold(table, live[0]);
    return;
  }

  while (true) {
    h.toAct = h.pending[0] || null;
    if (h.toAct) return; // someone still to act on this street

    // Street complete — reset per-street state.
    h.committed = {};
    h.currentBet = 0;
    h.lastRaiseSize = table.bb;
    h.actedSinceFullRaise = {};

    if (h.street === "river") {
      showdown(table);
      return;
    }

    // Deal next street.
    h.street = STREETS[STREETS.indexOf(h.street) + 1];
    if (h.street === "flop") h.board.push(h.deck.pop(), h.deck.pop(), h.deck.pop());
    else h.board.push(h.deck.pop());
    table.log.push({ t: Date.now(), kind: "street", street: h.street, board: [...h.board] });

    const actors = canAct(table);
    if (actors.length >= 2) {
      // First to act postflop: first live seat left of the button.
      const first = postflopFirst(table);
      h.pending = pendingFrom(table, first);
      h.toAct = h.pending[0] || null;
      if (h.toAct) return;
    } else {
      // Everyone (or all but one) all-in: run out the rest of the board.
      h.pending = [];
      if (h.street === "river") {
        showdown(table);
        return;
      }
    }
  }
}

function postflopFirst(table) {
  const order = table.hand.dealtIn;
  // Deal order already starts left of the button → first actor is the first
  // entry in deal order who can still act.
  for (const id of order) {
    if (!table.hand.folded[id] && !table.hand.allIn[id]) return id;
  }
  return null;
}

function finishByFold(table, winnerId) {
  const h = table.hand;
  const seat = seatById(table, winnerId);
  seat.stack += h.pot;
  h.results = {
    kind: "fold",
    pots: [{ amount: h.pot, winners: [winnerId] }],
    revealed: {},
  };
  h.toAct = null;
  h.street = "complete";
  table.log.push({ t: Date.now(), kind: "win_fold", who: winnerId, chips: h.pot });
}

// Side-pot construction + award.
function showdown(table) {
  const h = table.hand;
  h.street = "showdown";
  h.toAct = null;

  const live = inHand(table);
  const revealed = {};
  const scores = {};
  for (const id of live) {
    revealed[id] = h.holes[id];
    scores[id] = evaluate([...h.holes[id], ...h.board]);
  }

  // Pot layers from distinct commitment levels (all players, folded included —
  // their chips are dead money in the layers they reached).
  const levels = [...new Set(live.map((id) => h.totalCommitted[id] || 0))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const id of h.dealtIn) {
      const c = h.totalCommitted[id] || 0;
      amount += Math.max(0, Math.min(c, level) - prev);
    }
    const eligible = live.filter((id) => (h.totalCommitted[id] || 0) >= level);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }
  // Dead money committed above the highest live level (shouldn't happen in a
  // legal sequence, but never strand chips): fold it into the last pot.
  let strayDead = 0;
  for (const id of h.dealtIn) strayDead += Math.max(0, (h.totalCommitted[id] || 0) - prev);
  if (strayDead > 0 && pots.length > 0) pots[pots.length - 1].amount += strayDead;

  // Award each layer. Odd chips → earliest eligible seat in deal order.
  const awards = pots.map((pot) => {
    const best = Math.max(...pot.eligible.map((id) => scores[id]));
    const winners = pot.eligible.filter((id) => scores[id] === best);
    const share = Math.floor(pot.amount / winners.length);
    let leftover = pot.amount - share * winners.length;
    const orderedWinners = h.dealtIn.filter((id) => winners.includes(id));
    for (const id of orderedWinners) {
      const extra = leftover > 0 ? 1 : 0;
      leftover -= extra;
      seatById(table, id).stack += share + extra;
    }
    return { amount: pot.amount, winners: orderedWinners, hand: describeScore(best) };
  });

  h.results = {
    kind: "showdown",
    pots: awards,
    revealed,
    scores,
  };
  h.street = "complete";
  table.log.push({
    t: Date.now(),
    kind: "showdown",
    pots: awards.map((p) => ({ amount: p.amount, winners: p.winners, hand: p.hand })),
  });
}

// ── Between-hand actions ─────────────────────────────────────────────

// Queue a rebuy/top-up. Lands immediately when no hand is running.
export function addChips(table, playerId, chips) {
  const c = Math.floor(Number(chips) || 0);
  if (c <= 0) return { error: "Invalid chip amount" };
  const t = structuredClone(table);
  const seat = seatById(t, playerId);
  if (!seat) return { error: "Not seated" };
  seat.buyIns.push(c);
  if (t.hand && !t.hand.results && t.hand.dealtIn.includes(playerId)) {
    seat.pendingChips += c;
  } else {
    seat.stack += c;
  }
  t.log.push({ t: Date.now(), kind: "rebuy", who: playerId, chips: c, queued: seat.pendingChips > 0 });
  return { table: t };
}

export function setSittingOut(table, playerId, out) {
  const t = structuredClone(table);
  const seat = seatById(t, playerId);
  if (!seat) return { error: "Not seated" };
  seat.sittingOut = !!out;
  t.log.push({ t: Date.now(), kind: out ? "sit_out" : "sit_in", who: playerId });
  return { table: t };
}

// Seat a new player mid-session with one standard buy-in. They're dealt in
// from the next hand.
export function seatPlayer(table, player, startingStack) {
  if (table.seats.length >= MAX_SEATS) return { error: "Table full" };
  if (seatById(table, player.id)) return { error: "Already seated" };
  if (!(startingStack > 0)) return { error: "Invalid buy-in" };
  const t = structuredClone(table);
  t.seats.push({
    id: player.id,
    name: player.name,
    memberId: player.memberId ?? null,
    stack: startingStack,
    buyIns: [startingStack],
    pendingChips: 0,
    sittingOut: false,
  });
  t.log.push({ t: Date.now(), kind: "seat", who: player.id, chips: startingStack });
  return { table: t };
}

// Cash a player out between hands: freeze their buy-ins + final stack for
// settlement and remove the seat.
export function cashOutPlayer(table, playerId) {
  if (table.hand && !table.hand.results && table.hand.dealtIn.includes(playerId) && !table.hand.folded[playerId]) {
    return { error: "Finish the hand first" };
  }
  const t = structuredClone(table);
  const idx = t.seats.findIndex((s) => s.id === playerId);
  if (idx < 0) return { error: "Not seated" };
  const seat = t.seats[idx];
  t.cashedOut.push({
    id: seat.id,
    name: seat.name,
    memberId: seat.memberId,
    buyIns: seat.buyIns,
    finalChips: seat.stack + seat.pendingChips,
  });
  t.seats.splice(idx, 1);
  // Keep the button stable: removing a seat before the button shifts indices.
  if (idx < t.buttonIdx) t.buttonIdx -= 1;
  if (t.buttonIdx >= t.seats.length) t.buttonIdx = 0;
  t.log.push({ t: Date.now(), kind: "cash_out", who: playerId, chips: seat.stack });
  return { table: t };
}

// Settlement rows for everyone who ever sat: [{id,name,memberId,buyInChips,finalChips}].
export function settlementRows(table) {
  const rows = [];
  for (const s of table.cashedOut) {
    rows.push({
      id: s.id, name: s.name, memberId: s.memberId,
      buyInChips: s.buyIns.reduce((a, b) => a + b, 0),
      finalChips: s.finalChips,
    });
  }
  for (const s of table.seats) {
    rows.push({
      id: s.id, name: s.name, memberId: s.memberId,
      buyInChips: s.buyIns.reduce((a, b) => a + b, 0),
      finalChips: s.stack + s.pendingChips,
    });
  }
  return rows;
}

// Chip conservation check (debug/tests): buy-ins == stacks + pot + cashed out.
export function chipsBalanced(table) {
  const bought = settlementRows(table).reduce((s, r) => s + r.buyInChips, 0);
  const held =
    table.seats.reduce((s, x) => s + x.stack + x.pendingChips, 0) +
    table.cashedOut.reduce((s, x) => s + x.finalChips, 0) +
    (table.hand && !table.hand.results ? table.hand.pot : 0);
  return bought === held;
}

// ── Redaction ────────────────────────────────────────────────────────
// Per-viewer view: the deck never leaves the server; hole cards only for
// the viewer — except at showdown, where `results.revealed` is public.

export function redactFor(table, viewerId) {
  if (!table) return null;
  const h = table.hand;
  const recentLog = table.log.slice(-20);
  return {
    sb: table.sb,
    bb: table.bb,
    handNo: table.handNo,
    buttonId: seatId(table, table.buttonIdx) ?? null,
    seats: table.seats.map((s) => ({
      id: s.id,
      name: s.name,
      memberId: s.memberId,
      stack: s.stack,
      pendingChips: s.pendingChips,
      sittingOut: s.sittingOut,
      buyInChips: s.buyIns.reduce((a, b) => a + b, 0),
      buyInCount: s.buyIns.length,
    })),
    cashedOut: table.cashedOut,
    log: recentLog,
    hand: h
      ? {
          street: h.street,
          board: h.board,
          pot: h.pot,
          currentBet: h.currentBet,
          minRaiseTo: h.currentBet === 0 ? table.bb : h.currentBet + h.lastRaiseSize,
          toAct: h.toAct,
          dealtIn: h.dealtIn,
          folded: h.folded,
          allIn: h.allIn,
          committed: h.committed,
          totalCommitted: h.totalCommitted,
          yourHole: h.holes[viewerId] || null,
          results: h.results
            ? {
                kind: h.results.kind,
                pots: h.results.pots,
                revealed: h.results.revealed,
              }
            : null,
        }
      : null,
  };
}
