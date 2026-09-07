import { useCallback, useEffect, useRef, useState } from "react";
import { NotSignedIn } from "./auth";
import { SpotifyError, streamGenres, streamLibrary } from "./spotify";
import { clearLibraryCache, readLibraryCache, writeLibraryCache } from "./cache";

/** How often the growing library is published to React while pages stream in. */
const FLUSH_MS = 200;

/**
 * Loads Liked Songs progressively: the first page lands almost immediately and
 * is enough to start playing, while the rest stream in behind it and genres are
 * tagged last. Only a fully loaded library is cached.
 */
export function useLibrary(enabled) {
  const [tracks, setTracks] = useState([]);
  const [total, setTotal] = useState(0);
  const [complete, setComplete] = useState(false);
  const [genresDone, setGenresDone] = useState(0);
  const [genresTotal, setGenresTotal] = useState(0);
  const [genresComplete, setGenresComplete] = useState(false);
  const [error, setError] = useState(null);
  const [unauthorized, setUnauthorized] = useState(false);

  // Pages are stored by index so the library keeps Spotify's order (newest
  // save first) no matter which request finishes first. flat() drops the holes.
  const pagesRef = useRef([]);
  const flushTimer = useRef(null);
  const runId = useRef(0);

  const flush = useCallback(() => {
    if (flushTimer.current) {
      clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
    setTracks(pagesRef.current.flat());
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimer.current) return; // a flush is already pending
    flushTimer.current = setTimeout(() => {
      flushTimer.current = null;
      setTracks(pagesRef.current.flat());
    }, FLUSH_MS);
  }, []);

  const load = useCallback(
    async (force) => {
      const id = ++runId.current;
      const live = () => runId.current === id;

      pagesRef.current = [];
      setTracks([]);
      setTotal(0);
      setComplete(false);
      setGenresDone(0);
      setGenresTotal(0);
      setGenresComplete(false);
      setError(null);
      setUnauthorized(false);

      if (force) await clearLibraryCache();
      const cached = force ? null : await readLibraryCache();
      if (!live()) return;

      if (cached) {
        pagesRef.current = [cached.tracks];
        setTracks(cached.tracks);
        setTotal(cached.tracks.length);
        setComplete(true);

        if (cached.genresComplete) {
          setGenresComplete(true);
          return;
        }

        // Songs were cached before the genre pass finished; finish it now
        // instead of re-fetching the whole library.
        await streamGenres(cached.tracks, (done, uniqueArtists) => {
          if (!live()) return;
          setGenresDone(done);
          setGenresTotal(uniqueArtists);
        });
        if (!live()) return;
        setTracks([...cached.tracks]);
        setGenresComplete(true);
        await writeLibraryCache(cached.tracks, true);
        return;
      }

      try {
        await streamLibrary((pageIndex, pageTracks, reportedTotal) => {
          if (!live()) return;
          pagesRef.current[pageIndex] = pageTracks;
          setTotal(reportedTotal);
          // Publish the first page at once — that is what starts the game.
          if (pageIndex === 0) flush();
          else scheduleFlush();
        });
        if (!live()) return;

        flush();
        setComplete(true);

        const all = pagesRef.current.flat();
        // Persist before tagging genres: a reload mid-genre-pass should not
        // discard a library that took 150 requests to assemble.
        await writeLibraryCache(all, false);
        await streamGenres(all, (done, uniqueArtists) => {
          if (!live()) return;
          setGenresDone(done);
          setGenresTotal(uniqueArtists);
        });
        if (!live()) return;

        // streamGenres mutates the tracks; a new array reference makes the
        // filter memos recompute with the genres now present.
        setTracks([...all]);
        setGenresComplete(true);
        await writeLibraryCache(all, true);
      } catch (e) {
        if (!live()) return;
        if (e instanceof NotSignedIn) return setUnauthorized(true);
        if (e instanceof SpotifyError && e.status === 401) {
          return setUnauthorized(true);
        }
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [flush, scheduleFlush]
  );

  useEffect(() => {
    if (!enabled) return;
    // Streaming the library is the external system this hook synchronizes
    // with; it publishes pages through setState as they land.
    void load(false);
    return () => {
      // Deliberately the *current* counter, not a snapshot: bumping it is what
      // makes the in-flight run's live() checks start returning false.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      runId.current++;
      if (flushTimer.current) clearTimeout(flushTimer.current);
    };
  }, [enabled, load]);

  return {
    tracks,
    total,
    complete,
    genresDone,
    genresTotal,
    genresComplete,
    error,
    unauthorized,
    reload: useCallback(() => void load(true), [load]),
  };
}
