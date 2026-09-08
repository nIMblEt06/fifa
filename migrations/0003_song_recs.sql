-- Creator-curated recommendations for Know Your Song.
--
-- The hub owner's own Liked Songs, surfaced to whoever is playing so they can
-- pick up a song or two from someone else's taste. It is published from the
-- owner's browser rather than fetched here (see POST /api/song/recs/sync):
-- assembling 7,000 tracks plus their genres takes ~250 Spotify requests, far
-- past a Worker's subrequest budget, but nothing to a tab that has already
-- loaded the library to play the game.
CREATE TABLE IF NOT EXISTS song_recs (
  track_id   TEXT PRIMARY KEY,
  uri        TEXT NOT NULL,
  name       TEXT NOT NULL,
  artists    TEXT NOT NULL,
  art        TEXT,
  year       TEXT,
  -- Comma-delimited *and* comma-fenced (",indie rock,pop,") so matching one
  -- genre is a single LIKE '%,pop,%'. The fences are what stop "rock" from
  -- matching "punk rock".
  genres     TEXT NOT NULL DEFAULT ',',
  updated_at INTEGER NOT NULL
);
