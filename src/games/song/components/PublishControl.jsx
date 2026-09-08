import { useState } from "react";
import { publishLibrary } from "../utils/recs";

// Owner-only: pushes the signed-in account's library into D1 as the pool the
// marquee draws from. It lives here rather than in a script because the tab
// already holds the whole library — genres and all — where a Worker would have
// to rebuild it with hundreds of Spotify requests.
//
// Reached by loading "#/song?publish=<SONG_ADMIN_KEY>". Read at module scope
// on purpose: SongApp scrubs the hash on mount, so by the first render it is
// already gone.
const KEY = (() => {
  const query = window.location.hash.split("?")[1];
  return query ? new URLSearchParams(query).get("publish") : null;
})();

export default function PublishControl({ library, progress }) {
  const [state, setState] = useState(null); // { done, total } | { error } | { total }
  const [busy, setBusy] = useState(false);

  if (!KEY) return null;

  // Publishing early would bake in a partial library, and one with no genres —
  // which is exactly what the marquee's genre echo needs.
  const ready = progress.complete && progress.genresComplete;

  const run = async () => {
    setBusy(true);
    setState(null);
    try {
      const result = await publishLibrary(KEY, library, (done, total) =>
        setState({ done, total })
      );
      setState({ total: result.total });
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="song-publish">
      <div className="song-keep-head">
        <span className="song-chip-title">Publish recommendations</span>
        <button className="song-link" disabled={busy || !ready} onClick={() => void run()}>
          {busy ? "Publishing…" : `Publish ${library.length.toLocaleString()} songs`}
        </button>
      </div>
      <p className="song-note">
        {!ready
          ? "Waiting for the whole library and its genres to finish loading."
          : state?.error
            ? state.error
            : state?.total != null
              ? `Done — ${state.total.toLocaleString()} songs are now live on the marquee.`
              : state?.done != null
                ? `${state.done.toLocaleString()} / ${state.total.toLocaleString()}…`
                : "Replaces the marquee pool with this account's Liked Songs."}
      </p>
    </section>
  );
}
