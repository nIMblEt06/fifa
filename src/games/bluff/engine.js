// Pure game engine for "BLUFF" (the classic card game also known as
// Cheat / BS / "I Doubt It").
//
// Rules implemented here:
//   • Standard 52-card deck, dealt out as evenly as possible to all
//     players (3–8 players). Some players may start with one extra card.
//   • Play happens in ROUNDS. The round starter plays 1–4 cards FACE DOWN
//     and DECLARES a rank of their choice (e.g. "three Kings"). The claim
//     is the (count, rank) pair; the actual cards are hidden.
//   • Each subsequent active player, in turn order, must either:
//       (a) PLAY 1+ cards face down, claiming the SAME rank as the round,
//       (b) PASS, or
//       (c) call BLUFF on the most recent play.
//   • BLUFF: only the cards from the MOST RECENT play are revealed.
//       - If the claim was a LIE (any revealed card ≠ claimed rank) the
//         liar picks up the ENTIRE pile.
//       - If the claim was TRUE the challenger picks up the ENTIRE pile.
//     The winner of the challenge (truth-teller or successful challenger)
//     starts the NEXT round with a fresh rank declaration.
//   • PASS-AROUND BURN: if every other active player passes consecutively
//     after a play (i.e. the play comes back around untouched), the pile is
//     discarded face-down ("burned") and the last player to have played
//     starts a fresh round.
//   • GOING OUT: emptying your hand makes you provisionally out — but your
//     final play can still be bluff-called by the next player(s). If that
//     play was a lie you pick up the pile and you're back in. Players who
//     go out (and stay out) are ranked in finish order.
//   • Game ends when ≤1 player still holds cards. The last player holding
//     cards is the loser ("el crapico").
//
// Redaction (see redactFor):
//   • A viewer sees their own hand; for everyone else only hand counts.
//   • The pile is face-down: everyone sees the current round's claim
//     history (counts + the claimed rank) but never the actual cards…
//   • …except at a BLUFF reveal, where the revealed cards are written into
//     the reveal log event so every client can show the moment.
//
// This module is pure: same input → same output. Loaded by both the
// Cloudflare Durable Object (authoritative) and the client.

export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K"];
export const SUITS = ["S", "H", "D", "C"];
export const MIN_PLAYERS = 3;
export const MAX_PLAYERS = 8;
export const MAX_PLAY = 4; // most cards you can put down in one play

export function freshDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(`${r}${s}`);
  return deck;
}

export function rankOf(card) { return card[0]; }

// Fisher–Yates with an injectable RNG (so the DO can seed deterministically).
export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Create the starting game state.
//   players: [{id, name}]
export function startGame(players, _opts = {}, rng = Math.random) {
  if (players.length < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
  if (players.length > MAX_PLAYERS) throw new Error(`At most ${MAX_PLAYERS} players`);

  const deck = shuffle(freshDeck(), rng);
  const hands = {};
  for (const p of players) hands[p.id] = [];
  // Deal round-robin so the deck is split as evenly as possible.
  let i = 0;
  while (deck.length) {
    const pid = players[i % players.length].id;
    hands[pid].push(deck.shift());
    i++;
  }

  const state = {
    gameType: "bluff",
    players: players.map((p) => ({ id: p.id, name: p.name })),
    hands,
    pile: [],                 // cards in the middle, face down (hidden)
    burned: [],               // cards discarded out of play by pass-around burns
    // The claimed rank for the active round (null between rounds).
    claimRank: null,
    // History of plays in the CURRENT round: [{by, count, claim}].
    roundPlays: [],
    // The most recent play, the only one that can be bluff-called:
    //   { by, cards: [...], count, claim }
    lastPlay: null,
    // Count of consecutive passes since the last play (for burn detection).
    passes: 0,
    turn: players[0].id,
    out: [],                  // finish order: player ids that have emptied out
    log: [{ t: Date.now(), kind: "start", players: players.map((p) => p.id) }],
    loser: null,              // set when the game ends (last with cards)
    winner: null,             // first to go out — present for UI parity
  };
  return state;
}

// Idempotently fix state if the current player can't act. Safe to call on
// any state; used by the DO to self-heal on the next action.
export function healState(state) {
  if (!state || state.loser) return state;
  ensureTurnPlayable(state);
  maybeFinish(state);
  return state;
}

// Players who can still take a turn (hold ≥1 card and not finished). A player
// who just emptied their hand is no longer an actor, but their final play
// stays challengeable until the round resets (see finalizeProvisionalOuts).
function canActIds(state) {
  return state.players.map((p) => p.id).filter((id) => state.hands[id].length > 0 && !state.out.includes(id));
}

// Advance turn to the next player who can act (holds cards, not out).
function nextActor(state, fromId) {
  const order = state.players.map((p) => p.id);
  const start = order.indexOf(fromId);
  for (let k = 1; k <= order.length; k++) {
    const cand = order[(start + k) % order.length];
    if (state.hands[cand].length > 0 && !state.out.includes(cand)) return cand;
  }
  return null; // nobody else can act
}

// Apply a PLAY action: put `cards` (array of card strings from your hand)
// face down, claiming `claimRank`. On the first play of a round `claimRank`
// sets the round rank; subsequent plays must match it. Returns { state, error? }.
export function applyPlay(state, fromId, cards, claimRank) {
  if (state.loser) return { error: "Game already over" };
  if (state.turn !== fromId) return { error: "Not your turn" };
  if (state.out.includes(fromId)) return { error: "You're already out" };
  if (!Array.isArray(cards) || cards.length < 1) return { error: "Play at least one card" };
  if (cards.length > MAX_PLAY) return { error: `Play at most ${MAX_PLAY} cards` };

  const hand = state.hands[fromId];
  if (!hand) return { error: "Unknown player" };
  // Must actually hold every card you play, with no duplicates.
  const seen = new Set();
  for (const c of cards) {
    if (seen.has(c)) return { error: "Duplicate card in play" };
    seen.add(c);
    if (!hand.includes(c)) return { error: "You don't hold that card" };
  }

  // Determine / validate the claimed rank.
  const roundOpen = state.claimRank !== null;
  let claim;
  if (roundOpen) {
    // Mid-round: claim is locked to the round rank, ignore caller-supplied.
    claim = state.claimRank;
  } else {
    if (!RANKS.includes(claimRank)) return { error: "Choose a rank to declare" };
    claim = claimRank;
  }
  if (cards.length > hand.length) return { error: "You can't play more cards than you hold" };

  const next = structuredClone(state);
  next.hands[fromId] = hand.filter((c) => !seen.has(c));
  next.pile.push(...cards);
  next.claimRank = claim;
  next.lastPlay = { by: fromId, cards: [...cards], count: cards.length, claim };
  next.roundPlays.push({ by: fromId, count: cards.length, claim });
  next.passes = 0;
  next.log.push({
    t: Date.now(),
    kind: "play",
    by: fromId,
    count: cards.length,
    claim,
    opened: !roundOpen,
    wentOut: next.hands[fromId].length === 0,
  });

  // Turn passes to the next actor. A player who just emptied their hand is
  // skipped as an actor but their play stays challengeable.
  const after = nextActor(next, fromId);
  if (after === null) {
    // No one else can act (everyone else is out). The play stands; resolve.
    finalizeProvisionalOuts(next);
    ensureTurnPlayable(next);
  } else {
    next.turn = after;
  }
  maybeFinish(next);
  return { state: next };
}

// Apply a PASS action. Returns { state, error? }.
export function applyPass(state, fromId) {
  if (state.loser) return { error: "Game already over" };
  if (state.turn !== fromId) return { error: "Not your turn" };
  if (state.out.includes(fromId)) return { error: "You're already out" };
  if (!state.lastPlay) return { error: "Nothing to pass on — you must open the round" };

  const next = structuredClone(state);
  next.passes += 1;
  next.log.push({ t: Date.now(), kind: "pass", by: fromId });

  // Burn check: if everyone who could act (other than the last player) has now
  // passed consecutively, the pile is burned and the last player opens fresh.
  const others = canActIds(next).filter((id) => id !== next.lastPlay.by);
  if (next.passes >= others.length && others.length > 0) {
    burnPile(next, next.lastPlay.by);
  } else {
    const after = nextActor(next, fromId);
    if (after === null) {
      // Only the last player can act → burn back to them.
      burnPile(next, next.lastPlay.by);
    } else {
      next.turn = after;
    }
  }
  ensureTurnPlayable(next);
  maybeFinish(next);
  return { state: next };
}

// Apply a BLUFF call by `challengerId` against the most recent play.
// Returns { state, error? }.
export function applyBluff(state, challengerId) {
  if (state.loser) return { error: "Game already over" };
  if (state.turn !== challengerId) return { error: "Not your turn" };
  if (state.out.includes(challengerId)) return { error: "You're already out" };
  if (!state.lastPlay) return { error: "No play to call bluff on" };
  if (state.lastPlay.by === challengerId) return { error: "You can't call your own play" };

  const next = structuredClone(state);
  const play = next.lastPlay;
  const wasLie = play.cards.some((c) => rankOf(c) !== play.claim);
  // Loser of the challenge picks up the ENTIRE pile.
  const loserId = wasLie ? play.by : challengerId;
  const winnerId = wasLie ? challengerId : play.by;

  next.log.push({
    t: Date.now(),
    kind: "bluff",
    by: challengerId,
    against: play.by,
    claim: play.claim,
    count: play.count,
    revealed: [...play.cards],   // public reveal of just the last play
    wasLie,
    pickedUpBy: loserId,
    pileSize: next.pile.length,
  });

  // The challenge loser absorbs the pile. If the liar had gone out, picking up
  // the pile revives them (they're no longer out / provisionally out).
  next.hands[loserId] = [...next.hands[loserId], ...next.pile];
  next.pile = [];
  next.out = next.out.filter((id) => id !== loserId);

  // Start a fresh round; the challenge WINNER opens it (if they still hold
  // cards — if the winner went out by being truthful, they finish for real and
  // the next actor opens).
  resetRound(next);
  finalizeProvisionalOuts(next);

  let opener = winnerId;
  if (next.hands[winnerId].length === 0 || next.out.includes(winnerId)) {
    opener = nextActor(next, winnerId) ?? winnerId;
  }
  next.turn = opener;

  ensureTurnPlayable(next);
  maybeFinish(next);
  return { state: next };
}

// Burn the pile face-down and hand the fresh round to `openerId`.
function burnPile(state, openerId) {
  state.log.push({ t: Date.now(), kind: "burn", size: state.pile.length, opener: openerId });
  state.burned.push(...state.pile);
  state.pile = [];
  resetRound(state);
  finalizeProvisionalOuts(state);
  let opener = openerId;
  if (state.hands[openerId].length === 0 || state.out.includes(openerId)) {
    opener = nextActor(state, openerId) ?? openerId;
  }
  state.turn = opener;
}

function resetRound(state) {
  state.claimRank = null;
  state.roundPlays = [];
  state.lastPlay = null;
  state.passes = 0;
}

// Commit any provisionally-out player (emptied hand, play no longer
// challengeable because the round ended) to the finish order.
function finalizeProvisionalOuts(state) {
  for (const p of state.players) {
    if (state.hands[p.id].length === 0 && !state.out.includes(p.id)) {
      state.out.push(p.id);
      state.log.push({ t: Date.now(), kind: "out", who: p.id, place: state.out.length });
    }
  }
}

// If the player to move can't act (somehow out / no cards), advance to the
// next who can. Idempotent and safe.
function ensureTurnPlayable(state) {
  for (let safety = 0; safety < 256; safety++) {
    const cur = state.turn;
    if (cur && state.hands[cur]?.length > 0 && !state.out.includes(cur)) return;
    const next = nextActor(state, cur ?? state.players[0].id);
    if (next === null || next === cur) return;
    state.turn = next;
  }
}

function maybeFinish(state) {
  const stillIn = canActIds(state);
  if (stillIn.length <= 1) {
    // Game over: at most one player holds cards. Anyone with an empty hand
    // who isn't recorded yet finishes now; the last holder is the loser.
    const holders = state.players.map((p) => p.id).filter((id) => state.hands[id].length > 0);
    if (holders.length === 1) {
      // The single remaining card-holder is the loser; finalize everyone else.
      finalizeProvisionalOuts(state);
      state.loser = holders[0];
    } else {
      // 0 holders (a rare all-burn finish): the last player to go out loses.
      finalizeProvisionalOuts(state);
      state.loser = state.out[state.out.length - 1] ?? null;
    }
    // First player in `out` is the overall winner (for UI flavor).
    state.winner = state.out[0] ?? null;
    state.turn = null;
  }
}

// Build a per-player redacted view of the state.
export function redactFor(state, viewerId) {
  if (!state) return null;
  // Strip hidden card data from log events; keep bluff reveals public.
  const recent = state.log.slice(-30).map((e) => {
    if (e.kind === "bluff") return e; // revealed cards are intentionally public
    return e;                          // play/pass/burn/out carry no card data
  });

  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    handCount: state.hands[p.id]?.length ?? 0,
    out: state.out.includes(p.id),
    place: state.out.indexOf(p.id) >= 0 ? state.out.indexOf(p.id) + 1 : null,
  }));

  const you = {
    id: viewerId,
    hand: state.hands[viewerId] ? [...state.hands[viewerId]] : [],
  };

  // Last play exposed without its cards (only counts + claim are public).
  const lastPlayPublic = state.lastPlay
    ? { by: state.lastPlay.by, count: state.lastPlay.count, claim: state.lastPlay.claim }
    : null;

  return {
    gameType: "bluff",
    players,
    you,
    turn: state.turn,
    claimRank: state.claimRank,
    roundPlays: state.roundPlays.map((p) => ({ ...p })),
    lastPlay: lastPlayPublic,
    pileCount: state.pile.length,
    burnedCount: state.burned?.length ?? 0,
    passes: state.passes,
    out: [...state.out],
    loser: state.loser,
    winner: state.winner,
    log: recent,
  };
}
