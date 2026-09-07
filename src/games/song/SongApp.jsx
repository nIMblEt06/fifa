import { useCallback, useEffect, useRef, useState } from "react";
import { NotSignedIn, beginLogin, hasSession, logout } from "./utils/auth";
import { getProfile, SpotifyError } from "./utils/spotify";
import { useLibrary } from "./utils/useLibrary";
import { STAGES_SEC } from "./utils/tokens";
import Game from "./components/Game";

// Songless, from your own Liked Songs. Unlike the rest of the hub this game is
// personal rather than shared — the answer space is one player's own library —
// so it has no room code; it lives at #/song and gates on a Spotify session.

// The OAuth callback bounces back to "#/song?error=…" when sign-in fails.
function readCallbackError() {
  const q = window.location.hash.split("?")[1];
  if (!q) return null;
  return new URLSearchParams(q).get("error");
}

function clearCallbackError() {
  if (window.location.hash !== "#/song") {
    window.history.replaceState(null, "", "#/song");
  }
}

function Landing({ error, onConnect }) {
  return (
    <div className="song-landing">
      <div className="label">Songless, from your own library</div>
      <p className="song-pitch">
        Every round pulls a random track from your Spotify Liked Songs. You hear{" "}
        {STAGES_SEC[0]}s. Guess it, or skip for more — {STAGES_SEC.join("s · ")}s
        — and the answer only ever comes from music you already saved.
      </p>

      {error && (
        <div className="song-panel">
          <div className="label">Sign-in failed</div>
          <p className="song-fatal">{error}</p>
        </div>
      )}

      <button className="song-btn primary big" onClick={onConnect}>
        CONNECT SPOTIFY →
      </button>

      <p className="song-note">
        Playback runs through the Spotify Web Playback SDK: it needs Spotify
        Premium and a desktop browser.
      </p>
    </div>
  );
}

export default function SongApp({ onLeave }) {
  // A failed callback means the session is not usable — land on the sign-in
  // screen without waiting on (or trusting) a stale cookie. Otherwise null,
  // meaning "still checking": neither screen is right yet.
  const [authError, setAuthError] = useState(readCallbackError);
  const [signedIn, setSignedIn] = useState(() => (readCallbackError() ? false : null));
  const [blocked, setBlocked] = useState(null);
  const checked = useRef(false);

  const library = useLibrary(signedIn === true);

  useEffect(() => {
    clearCallbackError();
    if (signedIn === null) hasSession().then((ok) => setSignedIn(ok));
    // Runs once: the sign-in probe is a mount-time question, and signOut()
    // drives every later transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = useCallback(() => {
    checked.current = false;
    setBlocked(null);
    setAuthError(null);
    void logout().finally(() => setSignedIn(false));
  }, []);

  // Runs alongside the library stream rather than gating it, so the first page
  // of songs is already arriving while the account is being checked.
  useEffect(() => {
    if (signedIn !== true || checked.current) return;
    checked.current = true;

    getProfile()
      .then((p) => {
        if (p.product !== "premium") {
          setBlocked(
            "This account is not Spotify Premium. The Web Playback SDK only streams audio for Premium accounts."
          );
        }
      })
      .catch((e) => {
        if (e instanceof NotSignedIn) return signOut();
        if (e instanceof SpotifyError && e.status === 401) return signOut();
        setBlocked(e instanceof Error ? e.message : String(e));
      });
  }, [signedIn, signOut]);

  useEffect(() => {
    if (library.unauthorized) signOut();
  }, [library.unauthorized, signOut]);

  const fatal = blocked ?? (library.tracks.length === 0 ? library.error : null);

  const shell = (children) => (
    <div className="app">
      <header className="masthead">
        <h1>
          KNOW YOUR<span className="slash">/</span>SONG
        </h1>
        <div className="masthead-meta">
          {onLeave && (
            <button className="room" onClick={onLeave} title="Back to game picker">
              ← HUB
            </button>
          )}
          {signedIn && (
            <button className="room" onClick={signOut} title="Disconnect Spotify">
              DISCONNECT
            </button>
          )}
        </div>
      </header>
      <main>{children}</main>
    </div>
  );

  if (signedIn === null) return shell(<div className="room-loading-label">Checking Spotify…</div>);

  if (!signedIn) {
    return shell(<Landing error={authError} onConnect={beginLogin} />);
  }

  if (fatal) {
    return shell(
      <div className="song-panel">
        <div className="label">Something went wrong</div>
        <p className="song-fatal">{fatal}</p>
        <div className="song-btn-row">
          <button className="song-btn" onClick={signOut}>
            Disconnect
          </button>
          <button className="song-btn primary" onClick={library.reload}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Only the very first page is worth a loading screen; after that the game
  // starts and the rest of the library streams in behind it.
  if (library.tracks.length === 0) {
    return shell(
      library.complete ? (
        <div className="song-panel">
          <div className="label">Nothing to play</div>
          <p className="song-fatal">
            No Liked Songs found on this account. Save a few tracks in Spotify,
            then resync.
          </p>
          <button className="song-btn primary" onClick={library.reload}>
            Resync
          </button>
        </div>
      ) : (
        <div className="room-loading">
          <div className="room-loading-spinner" />
          <div className="room-loading-label">Opening your library…</div>
        </div>
      )
    );
  }

  return shell(
    <Game
      library={library.tracks}
      progress={{
        loaded: library.tracks.length,
        total: library.total,
        complete: library.complete,
        genresComplete: library.genresComplete,
      }}
      onRefresh={library.reload}
      onLogout={signOut}
    />
  );
}
