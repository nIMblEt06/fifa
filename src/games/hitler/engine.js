// Pure game engine for "Secret Hitler" — a social-deduction game.
//
// Secret Hitler is licensed under Creative Commons BY-NC-SA 4.0 by Goat, Wolf
// & Cabbage (secrethitler.com). This hub is a private, non-commercial app for
// friends, which the license permits. Attribution is also shown in the UI.
//
// This module is PURE: same input → same output. It is loaded by BOTH the
// Cloudflare Durable Object (authoritative) and the client. Hidden information
// (roles, drawn policies, votes-in-progress, investigation results) is removed
// per-viewer by `redactFor`. RNG is injectable so the DO can seed shuffles.
//
// ── OFFICIAL RULES IMPLEMENTED ─────────────────────────────────────────────
//
// Players: 5–10.
// Role distribution (Liberals / Fascists-excluding-Hitler / Hitler):
//    5p: 3L, 1F, +Hitler        6p: 4L, 1F, +Hitler
//    7p: 4L, 2F, +Hitler        8p: 5L, 2F, +Hitler
//    9p: 5L, 3F, +Hitler       10p: 6L, 3F, +Hitler
// (Fascist *team* size including Hitler: 2/2/3/3/4/4 for 5..10.)
//
// Knowledge: Fascists know each other AND who Hitler is. Hitler knows who the
// Fascist is ONLY in 5–6 player games; with 7+ players Hitler knows nothing.
//
// Policy deck: 6 Liberal + 11 Fascist (17 cards). When the draw pile has fewer
// than 3 cards, shuffle the discard pile back in.
//
// Round flow:
//   • Presidency rotates clockwise (skipping dead players).
//   • President nominates an eligible Chancellor. Term limits: the previous
//     ELECTED Chancellor is always ineligible; the previous ELECTED President
//     is ALSO ineligible when more than 5 players are still ALIVE. The current
//     President can never nominate themself.
//   • All ALIVE players vote Ja/Nein simultaneously; votes are hidden until
//     every alive player has voted, then revealed together.
//   • Majority Ja (strictly more Ja than Nein) → government elected.
//       - If 3+ fascist policies are enacted and the elected Chancellor is
//         Hitler → FASCISTS WIN immediately.
//       - Otherwise proceed to the legislative session.
//   • Failed vote (tie or majority Nein) → election tracker +1; presidency
//     passes to the next player. At tracker == 3, the top policy is enacted
//     automatically (NO presidential power, NO veto), the tracker resets, and
//     term limits are cleared.
//
// Legislative session:
//   • President draws the top 3 policies, discards 1 face-down → 2 to the
//     Chancellor, who enacts 1 (the other is discarded face-down).
//   • Veto power unlocks after 5 fascist policies are enacted: the Chancellor
//     may propose a veto on their 2 cards; if the President consents, BOTH are
//     discarded and the election tracker advances by 1 (a failed-government-
//     style bump that can trigger the auto-enact at 3). If the President
//     refuses, the Chancellor must enact one of the two.
//
// Presidential powers, triggered when a FASCIST policy is enacted, by the
// fascist-policy count reached and player count:
//    5–6 players:  F1 none, F2 none, F3 Policy Peek, F4 Execution, F5 Execution
//    7–8 players:  F1 none, F2 Investigate, F3 Special Election,
//                  F4 Execution, F5 Execution
//    9–10 players: F1 Investigate, F2 Investigate, F3 Special Election,
//                  F4 Execution, F5 Execution
//   - Investigate Loyalty: President sees a player's party membership
//     (Liberal/Fascist; Hitler shows as Fascist). A player may be investigated
//     at most once per game.
//   - Special Election: President picks ANY other alive player to be the next
//     President (out of normal rotation). After that single presidency, normal
//     clockwise rotation resumes from the player who WOULD have been next.
//   - Policy Peek: President privately views the top 3 policies of the draw
//     pile (order preserved, not drawn).
//   - Execution: President executes a player. They are out: no votes, cannot
//     be nominated. If the executed player is Hitler → LIBERALS WIN.
//
// Win conditions:
//   Liberals win if 5 liberal policies are enacted, OR Hitler is executed.
//   Fascists win if 6 fascist policies are enacted, OR Hitler is elected
//   Chancellor after 3+ fascist policies are enacted.

export const LIBERAL = "liberal";
export const FASCIST = "fascist";
export const HITLER = "hitler"; // role; party membership is FASCIST.

const LIBERAL_POLICIES = 6;
const FASCIST_POLICIES = 11;
const LIBERAL_WIN = 5;   // liberal policies to win
const FASCIST_WIN = 6;   // fascist policies to win
const MAX_TRACKER = 3;   // election tracker auto-enact threshold
const VETO_UNLOCK = 5;   // fascist policies needed before veto is available

// Role table: number of Liberals and Fascists (excluding Hitler) per count.
// Hitler is always exactly one additional player.
const ROLE_TABLE = {
  5:  { liberals: 3, fascists: 1 },
  6:  { liberals: 4, fascists: 1 },
  7:  { liberals: 4, fascists: 2 },
  8:  { liberals: 5, fascists: 2 },
  9:  { liberals: 5, fascists: 3 },
  10: { liberals: 6, fascists: 3 },
};

export function roleCountsFor(n) {
  const t = ROLE_TABLE[n];
  if (!t) return null;
  return { liberals: t.liberals, fascists: t.fascists, hitler: 1 };
}

// Fisher–Yates with an injectable RNG.
export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function freshPolicyDeck(rng) {
  const deck = [];
  for (let i = 0; i < LIBERAL_POLICIES; i++) deck.push(LIBERAL);
  for (let i = 0; i < FASCIST_POLICIES; i++) deck.push(FASCIST);
  return shuffle(deck, rng);
}

// ── State construction ─────────────────────────────────────────────────────

// players: [{id, name}], 5–10 of them.
export function startGame(players, _opts = {}, rng = Math.random) {
  const n = players.length;
  if (n < 5 || n > 10) throw new Error("Secret Hitler needs 5–10 players");
  const counts = roleCountsFor(n);
  if (!counts) throw new Error("Unsupported player count");

  // Build and shuffle the role bag.
  const roleBag = [];
  for (let i = 0; i < counts.liberals; i++) roleBag.push(LIBERAL);
  for (let i = 0; i < counts.fascists; i++) roleBag.push(FASCIST);
  roleBag.push(HITLER);
  const shuffledRoles = shuffle(roleBag, rng);

  // Seat order is the join order (clockwise table).
  const seating = players.map((p) => p.id);
  const roles = {};
  players.forEach((p, i) => { roles[p.id] = shuffledRoles[i]; });

  const deck = freshPolicyDeck(rng);

  // First President: random alive player (seat 0 of a shuffled rotation start).
  // We keep seating fixed and just pick a starting index deterministically via
  // the RNG so it's not always the host.
  const startIdx = Math.floor(rng() * n);

  const state = {
    players: players.map((p) => ({ id: p.id, name: p.name })),
    seating,
    roles,                         // hidden; redacted per knowledge rules
    alive: Object.fromEntries(seating.map((id) => [id, true])),

    deck,                          // draw pile (top = index 0)
    discard: [],
    liberalPolicies: 0,
    fascistPolicies: 0,

    presidentIdx: startIdx,        // index into `seating`
    president: seating[startIdx],
    chancellor: null,
    // Term-limit memory: last ELECTED government.
    lastElected: { president: null, chancellor: null },

    electionTracker: 0,

    phase: "nomination",           // see PHASES below
    nominee: null,                 // chancellor candidate during voting
    votes: {},                     // playerId -> "ja" | "nein" (in progress)
    lastVotes: null,               // revealed result of the last election

    // Legislative working area (hidden except to the relevant official).
    presidentDraw: null,           // 3 policies, visible only to President
    chancellorCards: null,         // 2 policies, visible only to Chancellor
    vetoRequested: false,

    // Powers.
    pendingPower: null,            // {kind, by} when a power must be resolved
    investigated: {},              // playerId -> true (once-per-game cap)
    investigationResult: null,     // {by, target, party} private to `by`
    specialElectionReturnIdx: null,// where rotation resumes after a special

    peek: null,                    // {by, cards:[3]} private to `by`

    winner: null,                  // null | LIBERAL | FASCIST
    winReason: null,
    log: [{ t: Date.now(), kind: "start", players: n }],
  };

  return state;
}

// PHASES:
//   "nomination"   — President nominates a Chancellor.
//   "voting"       — all alive players cast Ja/Nein.
//   "legislative_president"   — President discards 1 of 3.
//   "legislative_chancellor"  — Chancellor enacts 1 of 2 (or proposes veto).
//   "veto"         — President responds to a veto request.
//   "power"        — President must resolve a presidential power.
//   "gameover"     — winner set.

// ── Helpers ────────────────────────────────────────────────────────────────

export function partyOf(role) {
  return role === LIBERAL ? LIBERAL : FASCIST; // Hitler's party is Fascist.
}

function aliveIds(state) {
  return state.seating.filter((id) => state.alive[id]);
}

function aliveCount(state) {
  return aliveIds(state).length;
}

// Next alive seat after `idx` (clockwise), returns the index.
function nextAliveIdx(state, idx) {
  const n = state.seating.length;
  for (let k = 1; k <= n; k++) {
    const j = (idx + k) % n;
    if (state.alive[state.seating[j]]) return j;
  }
  return idx;
}

// Eligible Chancellor nominees for the current President.
export function eligibleChancellors(state) {
  const pres = state.president;
  const moreThanFive = aliveCount(state) > 5;
  return aliveIds(state).filter((id) => {
    if (id === pres) return false;
    if (id === state.lastElected.chancellor) return false;
    if (moreThanFive && id === state.lastElected.president) return false;
    return true;
  });
}

function ensureDeck(state) {
  if (state.deck.length < 3) {
    state.deck = shuffle([...state.deck, ...state.discard], state._rng || Math.random);
    state.discard = [];
  }
}

// ── Reshuffle note ──
// We need a deterministic RNG inside enact paths too. The DO seeds startGame's
// RNG; for mid-game reshuffles we accept an optional rng on the action and stash
// it on state via `withRng`. Default is Math.random (fine for the client, which
// never persists authoritative reshuffles).

function clone(state) {
  const rng = state._rng;
  const next = structuredClone({ ...state, _rng: undefined });
  next._rng = rng;
  return next;
}

export function withRng(state, rng) {
  state._rng = rng;
  return state;
}

// ── Actions ────────────────────────────────────────────────────────────────

// President nominates a Chancellor.
export function nominateChancellor(state, byId, targetId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "nomination") return { error: "Not the nomination phase" };
  if (byId !== state.president) return { error: "Only the President nominates" };
  if (!state.alive[targetId]) return { error: "Target is not in the game" };
  if (!eligibleChancellors(state).includes(targetId)) {
    return { error: "That player is not an eligible Chancellor" };
  }
  const next = clone(state);
  next.nominee = targetId;
  next.votes = {};
  next.phase = "voting";
  next.log.push({ t: Date.now(), kind: "nominate", president: byId, nominee: targetId });
  return { state: next };
}

// A player casts a vote.
export function castVote(state, byId, vote) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "voting") return { error: "Not the voting phase" };
  if (!state.alive[byId]) return { error: "Dead players don't vote" };
  if (vote !== "ja" && vote !== "nein") return { error: "Vote must be ja or nein" };
  if (state.votes[byId]) return { error: "You already voted" };

  const next = clone(state);
  next.votes[byId] = vote;

  const alive = aliveIds(next);
  const allVoted = alive.every((id) => next.votes[id]);
  if (!allVoted) {
    // Still hidden; just record.
    return { state: next };
  }

  // Reveal & tally.
  const jas = alive.filter((id) => next.votes[id] === "ja").length;
  const neins = alive.length - jas;
  const passed = jas > neins;
  next.lastVotes = {
    votes: { ...next.votes },
    ja: jas,
    nein: neins,
    passed,
    president: next.president,
    nominee: next.nominee,
  };
  next.log.push({
    t: Date.now(),
    kind: "vote_result",
    passed, ja: jas, nein: neins,
    president: next.president,
    chancellor: next.nominee,
  });

  if (passed) {
    next.chancellor = next.nominee;
    next.lastElected = { president: next.president, chancellor: next.nominee };
    next.electionTracker = 0;

    // Fascist win: Hitler elected Chancellor with 3+ fascist policies.
    if (next.fascistPolicies >= 3 && next.roles[next.chancellor] === HITLER) {
      endGame(next, FASCIST, "Hitler was elected Chancellor with 3+ fascist policies");
      return { state: next };
    }

    // Begin legislative session: President draws 3.
    beginLegislative(next);
  } else {
    // Failed election.
    next.electionTracker += 1;
    next.log.push({ t: Date.now(), kind: "election_failed", tracker: next.electionTracker });
    if (next.electionTracker >= MAX_TRACKER) {
      autoEnactTopPolicy(next);
      if (next.winner) return { state: next };
    }
    advancePresidency(next);
  }
  next.nominee = null;
  next.votes = {};
  return { state: next };
}

function beginLegislative(state) {
  ensureDeck(state);
  state.presidentDraw = state.deck.splice(0, 3);
  state.chancellorCards = null;
  state.vetoRequested = false;
  state.phase = "legislative_president";
  state.log.push({ t: Date.now(), kind: "legislative_start", president: state.president, chancellor: state.chancellor });
}

// President discards 1 of the 3 drawn policies (by index 0..2).
export function presidentDiscard(state, byId, index) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "legislative_president") return { error: "Not the President's discard phase" };
  if (byId !== state.president) return { error: "Only the President discards" };
  if (!state.presidentDraw || index < 0 || index >= state.presidentDraw.length) {
    return { error: "Invalid card index" };
  }
  const next = clone(state);
  const [discarded] = next.presidentDraw.splice(index, 1);
  next.discard.push(discarded);
  next.chancellorCards = next.presidentDraw; // remaining 2
  next.presidentDraw = null;
  next.phase = "legislative_chancellor";
  next.log.push({ t: Date.now(), kind: "president_discarded" });
  return { state: next };
}

// Chancellor enacts 1 of the 2 cards (by index 0..1).
export function chancellorEnact(state, byId, index) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "legislative_chancellor") return { error: "Not the Chancellor's enact phase" };
  if (byId !== state.chancellor) return { error: "Only the Chancellor enacts" };
  if (!state.chancellorCards || index < 0 || index >= state.chancellorCards.length) {
    return { error: "Invalid card index" };
  }
  const next = clone(state);
  const [enacted] = next.chancellorCards.splice(index, 1);
  next.discard.push(...next.chancellorCards); // the other card
  next.chancellorCards = null;
  next.vetoRequested = false;
  enactPolicy(next, enacted, /* viaPower */ false);
  return { state: next };
}

// Chancellor proposes a veto (only when 5+ fascist policies enacted).
export function proposeVeto(state, byId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "legislative_chancellor") return { error: "Not the Chancellor's phase" };
  if (byId !== state.chancellor) return { error: "Only the Chancellor proposes a veto" };
  if (state.fascistPolicies < VETO_UNLOCK) return { error: "Veto not yet unlocked" };
  if (state.vetoRequested) return { error: "Veto already proposed" };
  const next = clone(state);
  next.vetoRequested = true;
  next.phase = "veto";
  next.log.push({ t: Date.now(), kind: "veto_proposed", chancellor: byId });
  return { state: next };
}

// President responds to a veto. consent=true discards both; false sends it back.
export function respondVeto(state, byId, consent) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "veto") return { error: "No veto pending" };
  if (byId !== state.president) return { error: "Only the President answers a veto" };
  const next = clone(state);
  if (consent) {
    next.discard.push(...next.chancellorCards);
    next.chancellorCards = null;
    next.vetoRequested = false;
    next.log.push({ t: Date.now(), kind: "veto_agreed" });
    // A successful veto advances the election tracker like a failed government.
    next.electionTracker += 1;
    if (next.electionTracker >= MAX_TRACKER) {
      autoEnactTopPolicy(next);
      if (next.winner) return { state: next };
    }
    advancePresidency(next);
    finishGovernment(next);
  } else {
    next.vetoRequested = false;
    next.phase = "legislative_chancellor";
    next.log.push({ t: Date.now(), kind: "veto_rejected" });
  }
  return { state: next };
}

// ── Power resolutions ──────────────────────────────────────────────────────

// Investigate Loyalty.
export function investigatePlayer(state, byId, targetId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "power" || state.pendingPower?.kind !== "investigate") {
    return { error: "No investigation pending" };
  }
  if (byId !== state.president) return { error: "Only the President investigates" };
  if (byId === targetId) return { error: "Can't investigate yourself" };
  if (!state.alive[targetId]) return { error: "Target not in the game" };
  if (state.investigated[targetId]) return { error: "Player already investigated" };
  const next = clone(state);
  next.investigated[targetId] = true;
  next.investigationResult = {
    by: byId,
    target: targetId,
    party: partyOf(next.roles[targetId]), // Hitler shows as Fascist.
  };
  next.log.push({ t: Date.now(), kind: "investigated", president: byId, target: targetId });
  next.pendingPower = null;
  finishGovernment(next);
  return { state: next };
}

// Special Election: President picks the next President.
export function specialElection(state, byId, targetId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "power" || state.pendingPower?.kind !== "special_election") {
    return { error: "No special election pending" };
  }
  if (byId !== state.president) return { error: "Only the President picks" };
  if (byId === targetId) return { error: "Can't pick yourself" };
  if (!state.alive[targetId]) return { error: "Target not in the game" };
  const next = clone(state);
  // After the special-elected president serves, rotation resumes from the
  // player who would normally have followed the CURRENT president.
  next.specialElectionReturnIdx = nextAliveIdx(next, next.presidentIdx);
  const targetIdx = next.seating.indexOf(targetId);
  next.presidentIdx = targetIdx;
  next.president = targetId;
  next.log.push({ t: Date.now(), kind: "special_election", president: byId, target: targetId });
  next.pendingPower = null;
  // Skip the normal advancePresidency; go straight to nomination for target.
  next.chancellor = null;
  next.phase = "nomination";
  return { state: next };
}

// Policy Peek: President acknowledges having seen the top 3.
export function peekAck(state, byId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "power" || state.pendingPower?.kind !== "peek") {
    return { error: "No peek pending" };
  }
  if (byId !== state.president) return { error: "Only the President peeks" };
  const next = clone(state);
  next.peek = null;
  next.pendingPower = null;
  next.log.push({ t: Date.now(), kind: "peeked", president: byId });
  finishGovernment(next);
  return { state: next };
}

// Execution.
export function executePlayer(state, byId, targetId) {
  if (state.winner) return { error: "Game already over" };
  if (state.phase !== "power" || state.pendingPower?.kind !== "execution") {
    return { error: "No execution pending" };
  }
  if (byId !== state.president) return { error: "Only the President executes" };
  if (byId === targetId) return { error: "Can't execute yourself" };
  if (!state.alive[targetId]) return { error: "Target already out" };
  const next = clone(state);
  next.alive[targetId] = false;
  next.log.push({ t: Date.now(), kind: "executed", president: byId, target: targetId });
  next.pendingPower = null;

  if (next.roles[targetId] === HITLER) {
    endGame(next, LIBERAL, "Hitler was executed");
    return { state: next };
  }
  // If the executed player was the last-elected chancellor/president, their term
  // limit slot is now harmless (still recorded; dead players can't be nominated
  // anyway). No special handling needed.
  finishGovernment(next);
  return { state: next };
}

// ── Internal flow ──────────────────────────────────────────────────────────

function enactPolicy(state, policy, viaPower) {
  if (policy === LIBERAL) {
    state.liberalPolicies += 1;
    state.log.push({ t: Date.now(), kind: "policy_enacted", policy: LIBERAL, count: state.liberalPolicies });
    if (state.liberalPolicies >= LIBERAL_WIN) {
      endGame(state, LIBERAL, "5 liberal policies enacted");
      return;
    }
    finishGovernment(state);
    return;
  }

  // Fascist policy.
  state.fascistPolicies += 1;
  state.log.push({ t: Date.now(), kind: "policy_enacted", policy: FASCIST, count: state.fascistPolicies });
  if (state.fascistPolicies >= FASCIST_WIN) {
    endGame(state, FASCIST, "6 fascist policies enacted");
    return;
  }

  // Auto-enacts (election tracker) trigger NO power.
  if (viaPower) {
    finishGovernment(state);
    return;
  }

  const power = powerFor(state.players.length, state.fascistPolicies);
  if (power) {
    triggerPower(state, power);
  } else {
    finishGovernment(state);
  }
}

// The top policy is auto-enacted when the election tracker hits 3.
function autoEnactTopPolicy(state) {
  ensureDeck(state);
  const top = state.deck.shift();
  state.electionTracker = 0;
  // Term limits reset on a forced/chaos enact.
  state.lastElected = { president: null, chancellor: null };
  state.log.push({ t: Date.now(), kind: "chaos_enact", policy: top });
  enactPolicy(state, top, /* viaPower */ true); // no power for auto-enacts
}

// Returns the power kind for (playerCount, fascistPolicyCount) or null.
export function powerFor(playerCount, fascistCount) {
  if (playerCount <= 6) {
    if (fascistCount === 3) return "peek";
    if (fascistCount === 4) return "execution";
    if (fascistCount === 5) return "execution";
    return null;
  }
  if (playerCount <= 8) {
    if (fascistCount === 2) return "investigate";
    if (fascistCount === 3) return "special_election";
    if (fascistCount === 4) return "execution";
    if (fascistCount === 5) return "execution";
    return null;
  }
  // 9–10
  if (fascistCount === 1) return "investigate";
  if (fascistCount === 2) return "investigate";
  if (fascistCount === 3) return "special_election";
  if (fascistCount === 4) return "execution";
  if (fascistCount === 5) return "execution";
  return null;
}

function triggerPower(state, kind) {
  state.pendingPower = { kind, by: state.president };
  state.phase = "power";
  if (kind === "peek") {
    ensureDeck(state);
    state.peek = { by: state.president, cards: state.deck.slice(0, 3) };
  }
  state.log.push({ t: Date.now(), kind: "power", power: kind, president: state.president });
}

// Wrap up a government (after enact or power resolution) and start the next.
function finishGovernment(state) {
  if (state.winner) return;
  // Clear legislative scratch.
  state.presidentDraw = null;
  state.chancellorCards = null;
  state.vetoRequested = false;
  state.pendingPower = null;
  state.peek = null;
  // chancellor stays recorded as lastElected; clear the active slot.
  state.chancellor = null;
  advancePresidency(state);
}

function advancePresidency(state) {
  if (state.winner) return;
  if (state.specialElectionReturnIdx != null) {
    state.presidentIdx = state.specialElectionReturnIdx;
    state.specialElectionReturnIdx = null;
  } else {
    state.presidentIdx = nextAliveIdx(state, state.presidentIdx);
  }
  state.president = state.seating[state.presidentIdx];
  state.chancellor = null;
  state.nominee = null;
  state.votes = {};
  state.phase = "nomination";
}

function endGame(state, winner, reason) {
  state.winner = winner;
  state.winReason = reason;
  state.phase = "gameover";
  // Reveal nothing structurally — redactFor exposes roles once winner is set.
  state.log.push({ t: Date.now(), kind: "gameover", winner, reason });
}

// ── Redaction ──────────────────────────────────────────────────────────────

// Who does `viewerId` know the role of? Returns a map id->role for visible roles.
function knownRolesFor(state, viewerId) {
  const known = {};
  if (state.winner) {
    // Reveal everyone at game end.
    for (const id of state.seating) known[id] = state.roles[id];
    return known;
  }
  const myRole = state.roles[viewerId];
  if (!myRole) return known; // spectator
  known[viewerId] = myRole;

  const playerCount = state.players.length;

  if (myRole === FASCIST) {
    // Fascists know all other fascists AND Hitler.
    for (const id of state.seating) {
      if (state.roles[id] === FASCIST || state.roles[id] === HITLER) known[id] = state.roles[id];
    }
  } else if (myRole === HITLER) {
    // Hitler knows the (single) Fascist only in 5–6 player games.
    if (playerCount <= 6) {
      for (const id of state.seating) {
        if (state.roles[id] === FASCIST) known[id] = FASCIST;
      }
    }
  }
  return known;
}

// Build a per-viewer redacted view.
export function redactFor(state, viewerId) {
  if (!state) return null;
  const known = knownRolesFor(state, viewerId);
  const seated = state.roles[viewerId] != null;

  const players = state.players.map((p) => ({
    id: p.id,
    name: p.name,
    alive: state.alive[p.id],
    // Role only where known; otherwise null. Party derived for known fascists.
    role: known[p.id] || null,
    isPresident: p.id === state.president,
    isChancellor: p.id === state.chancellor,
    isNominee: p.id === state.nominee,
  }));

  // Votes: hidden until revealed. During voting we expose WHO has voted (not
  // how) so the UI can show progress; the actual ballots appear in lastVotes.
  const votedIds = Object.keys(state.votes);

  const base = {
    phase: state.phase,
    players,
    seating: state.seating,
    president: state.president,
    chancellor: state.chancellor,
    nominee: state.nominee,
    liberalPolicies: state.liberalPolicies,
    fascistPolicies: state.fascistPolicies,
    electionTracker: state.electionTracker,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    vetoUnlocked: state.fascistPolicies >= VETO_UNLOCK,
    vetoRequested: state.vetoRequested,
    winner: state.winner,
    winReason: state.winReason,
    lastVotes: state.lastVotes, // revealed ballots (public once tallied)
    votedIds,                   // who has voted so far (during voting)
    aliveCount: aliveCount(state),
    playerCount: state.players.length,
    pendingPower: state.pendingPower ? { kind: state.pendingPower.kind, by: state.pendingPower.by } : null,
    eligibleChancellors: state.phase === "nomination" ? eligibleChancellors(state) : [],
    investigated: Object.keys(state.investigated),
    log: redactLog(state, viewerId),
    you: seated
      ? { id: viewerId, role: state.roles[viewerId], party: partyOf(state.roles[viewerId]), alive: state.alive[viewerId] }
      : null,
  };

  // President's private draw.
  if (viewerId === state.president && state.presidentDraw) {
    base.presidentDraw = state.presidentDraw;
  }
  // Chancellor's private two cards.
  if (viewerId === state.chancellor && state.chancellorCards) {
    base.chancellorCards = state.chancellorCards;
  }
  // Policy peek (President only).
  if (state.peek && state.peek.by === viewerId) {
    base.peek = state.peek.cards;
  }
  // Investigation result (investigating President only).
  if (state.investigationResult && state.investigationResult.by === viewerId) {
    base.investigationResult = {
      target: state.investigationResult.target,
      party: state.investigationResult.party,
    };
  }

  return base;
}

// The log is mostly public. Strip private payloads (drawn/discarded contents,
// investigation parties, peeked cards) for non-owners. Most events here carry
// no secret payload by construction, so this is a light pass.
function redactLog(state, viewerId) {
  return state.log.slice(-40).map((e) => {
    if (e.kind === "investigated" && e.president !== viewerId) {
      // Public knows an investigation happened, not the result. (Result lives
      // in investigationResult, owner-only.)
      return e;
    }
    return e;
  });
}
