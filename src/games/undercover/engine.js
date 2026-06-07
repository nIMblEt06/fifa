// Pure game engine for "UNDERCOVER" (谁是卧底 / "Who is the Spy"),
// WITH the Mr. White role.
//
// This module is pure: same input (+ injectable RNG) → same output. It is
// loaded by both the Cloudflare Durable Object (authoritative) and the client.
// Exports startGame, apply* action fns returning { state, error? }, and
// redactFor(state, viewerId) hiding secret info per viewer.
//
// ── ROLES ──────────────────────────────────────────────────────────────
//   • CIVILIAN  — the majority. All civilians share the SAME secret word (A).
//   • UNDERCOVER — the impostor(s). They share a DIFFERENT but related word (B).
//   • MR. WHITE — knows NOTHING ("???"). Must blend in, then (if eliminated)
//     gets one guess at the civilian word to steal the win.
//   No one is told their own role; you only know your word (civilians/undercover)
//   or that you're blank (Mr. White). You infer your role from the clues.
//
// ── ROLE COUNTS (defaults by player count) ─────────────────────────────
//      4p  → 1 undercover, 0 Mr. White
//      5p  → 1 undercover, 1 Mr. White
//      6-7p → 1 undercover, 1 Mr. White
//      8-9p → 2 undercover, 1 Mr. White
//      10+ → 3 undercover, 1 Mr. White
//   Host may tweak counts in the lobby. Validation: undercover ≥ 1 and
//   civilians > undercover + mrWhite (civilians must be the strict majority).
//
// ── SETUP ──────────────────────────────────────────────────────────────
//   • Pick a random unused word pair (the room tracks used pair indices so
//     repeat games don't repeat words). Coin-flip which of the two words is
//     the civilian word vs the undercover word.
//   • Civilians get word A, undercovers get word B, Mr. White gets "???".
//   • Seat order is the player join order. Mr. White is never the FIRST
//     describer (the start-of-round describer pointer skips him for slot 0).
//
// ── ROUND = DESCRIBE then VOTE ─────────────────────────────────────────
//   DESCRIBE: in seat order, each ALIVE player types a one-line clue about
//     their word. The clue may not contain their own word (case-insensitive
//     substring check). Clues become public in order as they are submitted.
//   VOTE: every alive player votes simultaneously for someone to eliminate
//     (no self-votes). Votes are hidden until everyone has voted, then
//     revealed together. Most votes → eliminated. Ties → revote among the
//     tied players only. A second consecutive tie → no elimination this
//     round; advance to the next round.
//
// ── ELIMINATION ────────────────────────────────────────────────────────
//   Eliminating a player reveals their ROLE publicly. If MR. WHITE is
//   eliminated, the game pauses for him to type ONE guess at the civilian
//   word (normalized compare). Correct → Mr. White instantly WINS, game over.
//   Wrong → he's out and normal win checks proceed.
//
// ── WIN CHECKS (after each elimination resolves) ───────────────────────
//   • All undercovers AND Mr. White are dead → CIVILIANS win.
//   • (undercovers + Mr. White alive) ≥ (civilians alive) → IMPOSTORS win
//     (the surviving impostors are announced).
//   Game over reveals everyone's role + both words.
//
// ── REDACTION ──────────────────────────────────────────────────────────
//   A player sees ONLY their own word ("???" for Mr. White) and never the
//   roles of others until they are eliminated / game over. Spectators (no
//   seat) see clues and votes but no words until game over.

export const ROLE = {
  CIVILIAN: "civilian",
  UNDERCOVER: "undercover",
  MR_WHITE: "mrwhite",
};

export const PHASE = {
  DESCRIBE: "describe",
  VOTE: "vote",
  REVEAL: "reveal", // a vote was tallied; eliminated role shown briefly (transient bookkeeping)
  MR_WHITE_GUESS: "mrwhite_guess",
  OVER: "over",
};

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 12;
export const BLANK_WORD = "???";

// Fisher–Yates with an injectable RNG (so the DO can seed deterministically).
export function shuffle(arr, rng = Math.random) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Default role counts for a given player count. Returns { undercover, mrWhite }.
export function defaultRoleCounts(n) {
  if (n <= 4) return { undercover: 1, mrWhite: 0 };
  if (n <= 7) return { undercover: 1, mrWhite: 1 };
  if (n <= 9) return { undercover: 2, mrWhite: 1 };
  return { undercover: 3, mrWhite: 1 };
}

// Validate a role-count choice for `n` players. Returns null if OK, else a
// human error string.
export function validateRoleCounts(n, undercover, mrWhite) {
  if (n < MIN_PLAYERS) return `Need at least ${MIN_PLAYERS} players`;
  if (n > MAX_PLAYERS) return `At most ${MAX_PLAYERS} players`;
  if (!Number.isInteger(undercover) || !Number.isInteger(mrWhite)) {
    return "Role counts must be whole numbers";
  }
  if (undercover < 1) return "Need at least 1 undercover";
  if (mrWhite < 0) return "Mr. White count can't be negative";
  const civilians = n - undercover - mrWhite;
  if (civilians <= undercover + mrWhite) {
    return "Civilians must outnumber undercover + Mr. White";
  }
  return null;
}

// Normalize a free-text word/guess for comparison: lowercase, trim, collapse
// internal whitespace, strip surrounding punctuation.
export function normalizeWord(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Does a clue illegally contain the player's own word? (case-insensitive,
// whole-word-ish substring on the normalized forms).
export function clueContainsWord(clue, word) {
  const nw = normalizeWord(word);
  if (!nw) return false;
  const nc = normalizeWord(clue);
  if (!nc) return false;
  // token containment OR substring: catches "samosa" inside "samosas" too.
  if (nc === nw) return true;
  if (nc.includes(nw)) return true;
  // also block any individual token of a multi-word secret appearing alone
  const tokens = nw.split(" ");
  const clueTokens = new Set(nc.split(" "));
  for (const t of tokens) {
    if (t.length >= 3 && clueTokens.has(t)) return true;
  }
  return false;
}

// Build the starting game state.
//   players: [{ id, name }] in seat (join) order, 4..12 of them.
//   opts.pair: { a, b, cat } the chosen word pair (a=civilian, b=undercover
//              by convention, but we coin-flip which the civilians actually get).
//   opts.undercover, opts.mrWhite: role counts (defaults from defaultRoleCounts).
//   opts.pairIndex: index into the wordpairs array (recorded for used-tracking).
export function startGame(players, opts = {}, rng = Math.random) {
  if (!Array.isArray(players)) throw new Error("players must be an array");
  const n = players.length;
  if (n < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
  if (n > MAX_PLAYERS) throw new Error(`At most ${MAX_PLAYERS} players`);

  const defaults = defaultRoleCounts(n);
  const undercover = Number.isInteger(opts.undercover) ? opts.undercover : defaults.undercover;
  const mrWhite = Number.isInteger(opts.mrWhite) ? opts.mrWhite : defaults.mrWhite;
  const verr = validateRoleCounts(n, undercover, mrWhite);
  if (verr) throw new Error(verr);

  if (!opts.pair || typeof opts.pair.a !== "string" || typeof opts.pair.b !== "string") {
    throw new Error("Missing word pair");
  }

  // Coin-flip which side is the civilian word.
  const flip = rng() < 0.5;
  const civilianWord = flip ? opts.pair.a : opts.pair.b;
  const undercoverWord = flip ? opts.pair.b : opts.pair.a;

  // Assign roles to seat slots. Build a role bag and shuffle it.
  const civilians = n - undercover - mrWhite;
  const bag = [
    ...Array(civilians).fill(ROLE.CIVILIAN),
    ...Array(undercover).fill(ROLE.UNDERCOVER),
    ...Array(mrWhite).fill(ROLE.MR_WHITE),
  ];
  let roleOrder = shuffle(bag, rng);

  // Mr. White must never be the FIRST describer. If slot 0 drew Mr. White,
  // swap him with the first non-Mr.-White slot.
  if (roleOrder[0] === ROLE.MR_WHITE) {
    const swapIdx = roleOrder.findIndex((r) => r !== ROLE.MR_WHITE);
    if (swapIdx > 0) {
      [roleOrder[0], roleOrder[swapIdx]] = [roleOrder[swapIdx], roleOrder[0]];
    }
  }

  const seats = players.map((p, i) => {
    const role = roleOrder[i];
    let word = civilianWord;
    if (role === ROLE.UNDERCOVER) word = undercoverWord;
    else if (role === ROLE.MR_WHITE) word = BLANK_WORD;
    return {
      id: p.id,
      name: p.name,
      role,
      word,
      alive: true,
    };
  });

  const state = {
    players: seats,
    order: players.map((p) => p.id), // seat order
    civilianWord,
    undercoverWord,
    pairCat: opts.pair.cat || null,
    pairIndex: Number.isInteger(opts.pairIndex) ? opts.pairIndex : null,
    counts: { civilians, undercover, mrWhite },
    round: 1,
    phase: PHASE.DESCRIBE,
    // describe phase bookkeeping
    describeIdx: 0,                // pointer into the alive-in-seat-order list
    clues: {},                     // { [round]: { [playerId]: clue } }
    // vote phase bookkeeping
    votes: {},                     // { [voterId]: targetId } for the current (re)vote
    voteCandidates: null,          // null = everyone alive; else tied subset for a revote
    tieStreak: 0,                  // consecutive tied votes this round
    // mr white guess bookkeeping
    pendingMrWhite: null,          // playerId awaiting a guess
    winner: null,                  // null | "civilians" | "impostors" | "mrwhite"
    survivors: [],                 // ids of surviving impostors (impostor win) for the banner
    log: [{ t: Date.now(), kind: "start", round: 1 }],
  };

  return state;
}

// ── helpers ──────────────────────────────────────────────────────────────

function alivePlayers(state) {
  return state.order
    .map((id) => state.players.find((p) => p.id === id))
    .filter((p) => p && p.alive);
}

function seatById(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

// The player whose turn it is to describe right now (or null if describe done).
function currentDescriber(state) {
  const alive = alivePlayers(state);
  if (state.describeIdx >= alive.length) return null;
  return alive[state.describeIdx];
}

// Who is allowed to vote/be-voted in the current vote.
function voteEligible(state) {
  const alive = alivePlayers(state).map((p) => p.id);
  if (!state.voteCandidates) return alive;
  return alive.filter((id) => state.voteCandidates.includes(id));
}

function clone(state) {
  return structuredClone(state);
}

// ── APPLY: submit a describe clue ─────────────────────────────────────────
export function applyClue(state, playerId, clue) {
  if (state.winner) return { error: "Game is over" };
  if (state.phase !== PHASE.DESCRIBE) return { error: "Not the describe phase" };
  const seat = seatById(state, playerId);
  if (!seat) return { error: "Unknown player" };
  if (!seat.alive) return { error: "Eliminated players can't describe" };

  const cur = currentDescriber(state);
  if (!cur || cur.id !== playerId) return { error: "Not your turn to describe" };

  const text = String(clue || "").trim();
  if (!text) return { error: "Clue can't be empty" };
  if (text.length > 120) return { error: "Clue too long (max 120 chars)" };
  if (/\n/.test(clue)) return { error: "Clue must be a single line" };

  // Mr. White (blank word) can write anything; civilians/undercover can't
  // include their own word.
  if (seat.word !== BLANK_WORD && clueContainsWord(text, seat.word)) {
    return { error: "Your clue can't contain your own word" };
  }

  const next = clone(state);
  next.clues[next.round] = next.clues[next.round] || {};
  if (next.clues[next.round][playerId] !== undefined) {
    return { error: "You already described this round" };
  }
  next.clues[next.round][playerId] = text;
  next.log.push({ t: Date.now(), kind: "clue", round: next.round, by: playerId, clue: text });

  // Advance the describe pointer past the just-described player.
  next.describeIdx += 1;
  if (next.describeIdx >= alivePlayers(next).length) {
    // Describe phase complete → open voting.
    next.phase = PHASE.VOTE;
    next.votes = {};
    next.voteCandidates = null;
    next.tieStreak = 0;
    next.log.push({ t: Date.now(), kind: "vote_open", round: next.round });
  }
  return { state: next };
}

// ── APPLY: cast a vote ────────────────────────────────────────────────────
export function applyVote(state, voterId, targetId) {
  if (state.winner) return { error: "Game is over" };
  if (state.phase !== PHASE.VOTE) return { error: "Not the voting phase" };
  const voter = seatById(state, voterId);
  if (!voter || !voter.alive) return { error: "Only alive players can vote" };
  if (voterId === targetId) return { error: "Can't vote for yourself" };
  const target = seatById(state, targetId);
  if (!target || !target.alive) return { error: "Target isn't a live player" };

  const eligibleVoters = alivePlayers(state).map((p) => p.id);
  if (!eligibleVoters.includes(voterId)) return { error: "You can't vote" };

  // In a revote, the target must be one of the tied candidates.
  const candidates = voteEligible(state);
  if (state.voteCandidates && !candidates.includes(targetId)) {
    return { error: "Vote must be for a tied candidate" };
  }

  const next = clone(state);
  next.votes[voterId] = targetId;
  next.log.push({ t: Date.now(), kind: "vote_cast", round: next.round, by: voterId });

  // All alive players voted? Tally.
  const allVoted = eligibleVoters.every((id) => next.votes[id] !== undefined);
  if (allVoted) {
    return tallyVotes(next);
  }
  return { state: next };
}

function tallyVotes(state) {
  const counts = new Map();
  const tally = [];
  for (const [voter, target] of Object.entries(state.votes)) {
    counts.set(target, (counts.get(target) || 0) + 1);
    tally.push({ by: voter, target });
  }
  let max = 0;
  for (const v of counts.values()) if (v > max) max = v;
  const topped = [...counts.entries()].filter(([, v]) => v === max).map(([k]) => k);

  state.log.push({
    t: Date.now(),
    kind: "vote_result",
    round: state.round,
    tally,
    counts: Object.fromEntries(counts),
  });

  if (topped.length === 1) {
    return eliminate(state, topped[0]);
  }

  // Tie.
  state.tieStreak += 1;
  if (state.tieStreak >= 2) {
    // Second consecutive tie → no elimination, advance round.
    state.log.push({ t: Date.now(), kind: "tie_no_elim", round: state.round });
    return { state: nextRound(state) };
  }
  // First tie → revote among the tied players only.
  state.voteCandidates = topped;
  state.votes = {};
  state.log.push({ t: Date.now(), kind: "tie_revote", round: state.round, candidates: topped });
  return { state };
}

// Eliminate `targetId`, reveal role, run Mr. White guess flow or win checks.
function eliminate(state, targetId) {
  const seat = seatById(state, targetId);
  seat.alive = false;
  state.log.push({
    t: Date.now(),
    kind: "eliminated",
    round: state.round,
    who: targetId,
    role: seat.role,
  });

  if (seat.role === ROLE.MR_WHITE) {
    // Pause for Mr. White's single guess.
    state.phase = PHASE.MR_WHITE_GUESS;
    state.pendingMrWhite = targetId;
    state.votes = {};
    state.voteCandidates = null;
    state.log.push({ t: Date.now(), kind: "mrwhite_eliminated", who: targetId });
    return { state };
  }

  return { state: resolveAfterElimination(state) };
}

// After a non-Mr-White elimination (or a wrong Mr. White guess), check wins
// and either end the game or start the next round.
function resolveAfterElimination(state) {
  const alive = alivePlayers(state);
  const impostorsAlive = alive.filter(
    (p) => p.role === ROLE.UNDERCOVER || p.role === ROLE.MR_WHITE
  );
  const civiliansAlive = alive.filter((p) => p.role === ROLE.CIVILIAN);

  if (impostorsAlive.length === 0) {
    return finish(state, "civilians");
  }
  if (impostorsAlive.length >= civiliansAlive.length) {
    state.survivors = impostorsAlive.map((p) => p.id);
    return finish(state, "impostors");
  }
  return nextRound(state);
}

// ── APPLY: Mr. White's guess at the civilian word ─────────────────────────
export function applyMrWhiteGuess(state, playerId, guess) {
  if (state.winner) return { error: "Game is over" };
  if (state.phase !== PHASE.MR_WHITE_GUESS) return { error: "Not the Mr. White guess phase" };
  if (state.pendingMrWhite !== playerId) return { error: "It's not your guess to make" };
  const text = String(guess || "").trim();
  if (!text) return { error: "Guess can't be empty" };

  const next = clone(state);
  next.pendingMrWhite = null;
  const correct = normalizeWord(text) === normalizeWord(next.civilianWord);
  next.log.push({ t: Date.now(), kind: "mrwhite_guess", who: playerId, guess: text, correct });

  if (correct) {
    next.survivors = [playerId];
    return { state: finish(next, "mrwhite") };
  }
  return { state: resolveAfterElimination(next) };
}

// Advance to a fresh describe phase for the next round.
function nextRound(state) {
  state.round += 1;
  state.phase = PHASE.DESCRIBE;
  state.describeIdx = 0;
  state.votes = {};
  state.voteCandidates = null;
  state.tieStreak = 0;
  state.pendingMrWhite = null;
  state.log.push({ t: Date.now(), kind: "round", round: state.round });
  return state;
}

function finish(state, winner) {
  state.winner = winner;
  state.phase = PHASE.OVER;
  state.pendingMrWhite = null;
  state.log.push({
    t: Date.now(),
    kind: "game_over",
    winner,
    survivors: state.survivors,
    civilianWord: state.civilianWord,
    undercoverWord: state.undercoverWord,
  });
  return state;
}

// ── REDACTION ──────────────────────────────────────────────────────────────
// Build a per-viewer view of the state.
//   viewerId === null → spectator (clues/votes visible, no words/roles until over).
//   A seated player → sees their own word ("???" if Mr. White) and never other
//   roles until those players are eliminated / the game is over.
export function redactFor(state, viewerId) {
  if (!state) return null;
  const over = !!state.winner;
  const viewerSeat = seatById(state, viewerId);

  const players = state.players.map((p) => {
    const revealed = over || !p.alive; // role shown once eliminated or at game over
    return {
      id: p.id,
      name: p.name,
      alive: p.alive,
      role: revealed ? p.role : null,
      // word is never shown for other players until game over
      word: over ? p.word : (p.id === viewerId ? p.word : null),
      isYou: p.id === viewerId,
    };
  });

  // Public clues for every round (clues are public once submitted).
  const clues = state.clues;

  // Votes: hidden until the current (re)vote fully tallies. We expose only
  // *who has voted* during an open vote, and the full result via the log
  // (vote_result) after tally. So here we expose the count of votes cast.
  const votedIds = Object.keys(state.votes || {});

  // Every log entry the engine emits is already public-safe: clues are public,
  // vote_cast carries only the voter (never the target), vote_result/eliminate/
  // mrwhite_* only appear at reveal time. So no per-viewer stripping is needed.
  const recentLog = state.log.slice(-40);

  const base = {
    phase: state.phase,
    round: state.round,
    winner: state.winner,
    survivors: state.survivors,
    counts: state.counts,
    pairCat: state.pairCat,
    order: state.order,
    players,
    clues,
    describeIdx: state.describeIdx,
    currentDescriber: currentDescriberId(state),
    voteCandidates: state.voteCandidates,
    votedIds,                          // who has cast a vote (not their target)
    tieStreak: state.tieStreak,
    pendingMrWhite: state.pendingMrWhite,
    log: recentLog,
    // words only at game over (for everyone)
    civilianWord: over ? state.civilianWord : null,
    undercoverWord: over ? state.undercoverWord : null,
  };

  // The viewer's private slice.
  base.you = viewerSeat
    ? {
        id: viewerSeat.id,
        name: viewerSeat.name,
        alive: viewerSeat.alive,
        word: viewerSeat.word,                       // own word (or "???")
        role: over || !viewerSeat.alive ? viewerSeat.role : null,
        isMrWhite: viewerSeat.word === BLANK_WORD,   // hint without naming the role
      }
    : null;

  return base;
}

function currentDescriberId(state) {
  if (state.phase !== PHASE.DESCRIBE) return null;
  const cur = currentDescriber(state);
  return cur ? cur.id : null;
}
