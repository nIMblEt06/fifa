import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RECENT_MAX, pickTrack } from "../utils/library";
import { sameSong, sharesArtist } from "../utils/match";
import { usePlayer } from "../utils/usePlayer";
import { STAGES_SEC, MAX_GUESSES } from "../utils/tokens";
import {
  NO_FILTERS, applyFilters, buildFacets, loadFilters, saveFilters, toggle,
} from "../utils/filters";
import { usePlaylistState } from "../utils/playlist";
import { readStats, recordRound, resetStats } from "../utils/stats";
import { pickGenre } from "../utils/recs";
import GuessInput from "./GuessInput";
import FilterBar from "./FilterBar";
import StatsPanel from "./StatsPanel";
import Marquee from "./Marquee";
import PlaylistBar from "./PlaylistBar";
import KeepButton from "./KeepButton";
import PublishControl from "./PublishControl";

// A guess is { text, sub, kind } where kind is
// "wrong" | "artist" | "skipped" | "correct". "artist" is still a miss, but a
// near one: right artist, wrong track.

const RECENT_KEY = "song.recent";
const TOTAL = STAGES_SEC[STAGES_SEC.length - 1];

function readRecent() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function pushRecent(id) {
  const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* blocked storage — repeats are the only cost */ }
}

function classify(guessed, answer) {
  // Libraries routinely hold the same song twice under different track ids
  // (a remaster, a reissue, a single and its album cut). Naming the song is
  // the point of the game, so any release of it counts.
  if (sameSong(guessed, answer)) return "correct";
  return sharesArtist(guessed, answer) ? "artist" : "wrong";
}

const MARK = { correct: "✓", artist: "~", wrong: "✗", skipped: "–" };

export default function Game({ library, progress, onRefresh, onLogout }) {
  const [volume, setVolume] = useState(0.7);
  const { playlist, adding } = usePlaylistState();
  const playlistIds = useMemo(
    () => new Set(playlist?.trackIds ?? []),
    [playlist]
  );
  const [stats, setStats] = useState(readStats);
  // One genre off the track just guessed, so the strip can answer with
  // something adjacent to what the player was listening to.
  const [echoGenre, setEchoGenre] = useState(null);
  // Which distribution row the round just finished in, so the panel can point
  // at it. Null after a loss: a loss belongs in no bucket.
  const [lastBucket, setLastBucket] = useState(null);
  const { status, error, playError, playing, prime, playClip, playFull, halt } =
    usePlayer(volume);

  const [filters, setFilters] = useState(loadFilters);

  const facets = useMemo(() => buildFacets(library), [library]);
  const pool = useMemo(() => applyFilters(library, filters), [library, filters]);

  // Set only by a filter click, so restoring saved filters on mount does not
  // count as a change and restart the round.
  const restartRef = useRef(false);

  const updateFilters = useCallback((next) => {
    setFilters(next);
    saveFilters(next);
    restartRef.current = true;
  }, []);

  const [track, setTrack] = useState(null);
  const [guesses, setGuesses] = useState([]);
  const [outcome, setOutcome] = useState("playing"); // playing | won | lost
  const [cueing, setCueing] = useState(false);
  const [cueError, setCueError] = useState(null);
  // Filters can match nothing in the pages loaded so far; that is a wait, not
  // a failure, so the round starts itself as soon as a match streams in.
  const [awaitingPool, setAwaitingPool] = useState(false);

  const startedRef = useRef(false);
  // Rounds can overlap: a "Next song" double-click, a filter change landing
  // mid-cue, or the awaiting-pool effect re-firing as the library streams in.
  // A superseded round must stop touching the UI — otherwise it clears
  // `cueing` for a cue that is still running, or reports its own abandoned
  // track as unplayable.
  const roundId = useRef(0);
  const done = outcome !== "playing";
  const stage = Math.min(guesses.length, STAGES_SEC.length - 1);
  const unlocked = STAGES_SEC[stage];

  const newRound = useCallback(async () => {
    const id = ++roundId.current;
    const live = () => roundId.current === id;

    setCueError(null);
    setAwaitingPool(false);
    setGuesses([]);
    setOutcome("playing");
    setLastBucket(null);
    setCueing(true);
    await halt();
    if (!live()) return;

    if (pool.length === 0) {
      if (progress.complete) setCueError("No songs match the current filters.");
      else setAwaitingPool(true);
      setCueing(false);
      return;
    }

    // A track can fail to cue (region-locked, pulled from the catalogue).
    // Quietly try a couple of others before giving up on the round.
    let lastError = "Could not start a track.";
    for (let attempt = 0; attempt < 3; attempt++) {
      const next = pickTrack(pool, readRecent());
      setTrack(next);
      pushRecent(next.id);
      try {
        await prime(next.uri);
        if (!live()) return;
        setCueing(false);
        return;
      } catch (e) {
        if (!live()) return;
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    setCueError(lastError);
    setCueing(false);
  }, [pool, prime, halt, progress.complete]);

  // Cueing a round is an external action (it drives the Spotify SDK), so it
  // belongs in an effect even though it also sets state on the way in.
  useEffect(() => {
    if (status !== "ready" || startedRef.current) return;
    startedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void newRound();
  }, [status, newRound]);

  // A matching song has since streamed in — begin.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (awaitingPool && pool.length > 0) void newRound();
  }, [awaitingPool, pool.length, newRound]);

  // Held in a ref so the restart effect below can depend on filters alone.
  // Depending on newRound directly would re-arm the timer on every streaming
  // flush, and the restart would never fire until the library finished.
  const newRoundRef = useRef(newRound);
  useEffect(() => {
    newRoundRef.current = newRound;
  });

  // Changing a filter replaces the current song rather than waiting for the
  // next one. Debounced, so picking several chips cues one track, not five.
  useEffect(() => {
    if (!restartRef.current) return;
    const timer = setTimeout(() => {
      restartRef.current = false;
      void newRoundRef.current();
    }, 450);
    return () => clearTimeout(timer);
  }, [filters]);

  function record(guess) {
    const next = [...guesses, guess];
    setGuesses(next);

    if (guess.kind === "correct") {
      setOutcome("won");
      setStats(recordRound(true, next.length));
      setLastBucket(next.length);
      setEchoGenre(pickGenre(track));
      void playFull();
      return;
    }
    if (next.length >= MAX_GUESSES) {
      setOutcome("lost");
      setStats(recordRound(false, next.length));
      setLastBucket(null);
      setEchoGenre(pickGenre(track));
      void playFull();
    }
  }

  function onGuess(guessed) {
    if (!track || done) return;
    record({
      text: guessed.name,
      sub: guessed.artists,
      kind: classify(guessed, track),
    });
  }

  function onSkip() {
    if (done) return;
    record({ text: "Skipped", sub: "", kind: "skipped" });
  }

  if (status === "error") {
    return (
      <div className="song-panel">
        <div className="label">Player error</div>
        <p className="song-fatal">{error}</p>
        <p className="song-note">
          The Web Playback SDK needs a Spotify Premium account and a desktop
          Chrome, Edge, Firefox or Safari window.
        </p>
        <button className="song-btn" onClick={onLogout}>
          Disconnect
        </button>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="song-panel">
        <div className="room-loading-label">Starting the player…</div>
      </div>
    );
  }

  const remaining = MAX_GUESSES - guesses.length;
  const nextGain = done
    ? 0
    : STAGES_SEC[Math.min(guesses.length + 1, STAGES_SEC.length - 1)] - unlocked;

  return (
    <div className="song-game">
      <FilterBar
        facets={facets}
        filters={filters}
        poolSize={pool.length}
        total={library.length}
        progress={progress}
        onToggle={(group, id) => updateFilters(toggle(filters, group, id))}
        onClear={() => updateFilters(NO_FILTERS)}
      />

      {/* The only progress indicator: how much of the track is unlocked. */}
      <section className="song-scrub-wrap">
        <div
          className="song-scrub"
          role="img"
          aria-label={`${unlocked} seconds unlocked of ${TOTAL}`}
        >
          <div
            className="song-scrub-fill"
            style={{ width: `${(unlocked / TOTAL) * 100}%` }}
          />
          {STAGES_SEC.map((s, i) => (
            <span
              key={s}
              className={"song-scrub-tick " + (i <= stage ? "reached" : "")}
              style={{ left: `${(s / TOTAL) * 100}%` }}
            />
          ))}
        </div>
        <div className="song-scrub-legend">
          <span className="song-seconds">{done ? "Full track" : `${unlocked}s`}</span>
          <span className="song-meta">
            {done
              ? outcome === "won"
                ? `Solved in ${guesses.length}`
                : "Out of guesses"
              : `${remaining} ${remaining === 1 ? "guess" : "guesses"} left`}
          </span>
        </div>
      </section>

      {awaitingPool && (
        <p className="song-note">
          No matches in the {progress.loaded.toLocaleString()} songs loaded so
          far. Still loading
          {progress.total ? ` of ${progress.total.toLocaleString()}` : ""} — this
          will start on its own.
        </p>
      )}

      {cueError && (
        <div className="song-panel">
          <div className="label">Could not cue a track</div>
          <p className="song-fatal">{cueError}</p>
          <button className="song-btn" onClick={() => void newRound()}>
            Try another song
          </button>
        </div>
      )}

      {playError && <p className="error">{playError}</p>}

      <div className="song-btn-row">
        <button
          className="song-btn primary"
          disabled={cueing || !track}
          onClick={() => (done ? void playFull() : void playClip(unlocked))}
        >
          {cueing ? "Cueing…" : done ? "Play track" : `Play ${unlocked}s`}
        </button>
        <button className="song-btn" disabled={!playing} onClick={() => void halt()}>
          Stop
        </button>
      </div>

      {/* All seven rows exist from the start, so nothing below ever moves. */}
      <ol className="song-guesses">
        {Array.from({ length: MAX_GUESSES }, (_, i) => {
          const g = guesses[i];
          const isNext = !done && i === guesses.length;
          return (
            <li
              key={i}
              className={
                "song-guess kind-" + (g?.kind ?? "empty") + (isNext ? " next" : "")
              }
            >
              <span className="song-guess-num">{i + 1}</span>
              {g ? (
                <span className="song-guess-body">
                  <span className="song-guess-text">
                    {g.text}
                    {g.sub && <small>{g.sub}</small>}
                  </span>
                  {g.kind === "artist" && (
                    <span className="song-guess-tag">right artist</span>
                  )}
                  <span className="song-guess-mark">{MARK[g.kind]}</span>
                </span>
              ) : (
                <span className="song-guess-placeholder">
                  {isNext ? `Guess with ${unlocked}s` : ""}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      <div className="song-action-slot">
        {done && track ? (
          <div className="song-reveal-wrap">
            <div className="song-reveal">
              {track.art && <img src={track.art} alt="" />}
              <div className="song-reveal-text">
                <h2 className="song-reveal-title">{track.name}</h2>
                <p className="song-reveal-sub">{track.artists}</p>
                <p className="song-reveal-meta">
                  {track.album} · {track.year}
                </p>
              </div>
              <KeepButton
                track={track}
                inPlaylist={playlistIds.has(track.id)}
                adding={adding.has(track.id)}
                big
              />
            </div>
            <button
              className="song-btn primary"
              disabled={cueing}
              onClick={() => void newRound()}
            >
              {cueing ? "Cueing…" : "Next song"}
            </button>

            <StatsPanel
              stats={stats}
              highlight={lastBucket}
              onReset={() => setStats(resetStats())}
            />
          </div>
        ) : (
          <GuessInput
            library={library}
            disabled={cueing || !track}
            onGuess={onGuess}
            onSkip={onSkip}
            skipLabel={
              remaining <= 1 ? "Give up" : `Skip · +${Number(nextGain.toFixed(1))}s`
            }
          />
        )}
      </div>

      <Marquee
        genre={echoGenre}
        roundKey={stats.rounds}
        playlistIds={playlistIds}
        adding={adding}
      />

      <PlaylistBar />

      <PublishControl library={library} progress={progress} />

      <footer className="song-foot">
        <span className="song-meta">Vol</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          aria-label="Volume"
        />
        <button className="song-link" onClick={onRefresh}>
          Resync
        </button>
        <button className="song-link" onClick={onLogout}>
          Disconnect
        </button>
      </footer>
    </div>
  );
}
