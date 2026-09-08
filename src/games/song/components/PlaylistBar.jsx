import { dismissPlaylistError, forgetPlaylist, usePlaylistState } from "../utils/playlist";

// A status line, not a workflow. The playlist is filled a song at a time by
// the ♡s above it, so there is nothing here to confirm or submit — only where
// the songs went, and the two things that can go wrong.
export default function PlaylistBar() {
  const { playlist, error } = usePlaylistState();

  if (!playlist && !error) return null;

  const count = playlist?.trackIds.length ?? 0;

  return (
    <section className="song-keep">
      {playlist && (
        <div className="song-keep-head">
          <span className="song-keep-title">
            {playlist.name}
            <span className="song-chip-count">{count}</span>
          </span>
          <span className="song-keep-status">
            {count === 1 ? "song" : "songs"} added
            {playlist.url && (
              <>
                {" · "}
                <a
                  className="song-link"
                  href={playlist.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open in Spotify
                </a>
              </>
            )}
            {" · "}
            <button
              className="song-link"
              onClick={forgetPlaylist}
              title="Stop adding to this playlist; the next ♡ starts a new one"
            >
              New playlist
            </button>
          </span>
        </div>
      )}

      {error && (
        <p className="error">
          {error}{" "}
          <button className="song-link" onClick={dismissPlaylistError}>
            Dismiss
          </button>
        </p>
      )}
    </section>
  );
}
