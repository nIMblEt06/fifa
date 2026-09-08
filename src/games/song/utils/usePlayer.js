import { useCallback, useEffect, useRef, useState } from "react";
import { getAccessToken } from "./auth";
import { playTrack, transferPlayback } from "./spotify";

const SDK_SRC = "https://sdk.scdn.co/spotify-player.js";

let sdkReady = null;

function loadSdk() {
  sdkReady ??= new Promise((resolve, reject) => {
    if (window.Spotify) return resolve();
    window.onSpotifyWebPlaybackSDKReady = () => resolve();
    const script = document.createElement("script");
    script.src = SDK_SRC;
    script.async = true;
    script.onerror = () => reject(new Error("Could not load the Spotify player."));
    document.body.appendChild(script);
  });
  return sdkReady;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `check` until it is true or the budget runs out. */
async function waitUntil(check, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

const isOurs = (state, uri) =>
  state?.track_window?.current_track?.uri === uri;

export function usePlayer(volume) {
  const playerRef = useRef(null);
  const deviceIdRef = useRef(null);
  const stopTimer = useRef(null);
  const volumeRef = useRef(volume);
  // Which prime() call owns the player, or 0 when none does. A counter rather
  // than a flag: two overlapping primes (a fast "Next song" double-click, a
  // filter change landing mid-cue) would otherwise have the first one's
  // cleanup unmute the player while the second is still loading, and the
  // track would play out loud from the top.
  const primeIdRef = useRef(0);
  const owningPrimeRef = useRef(0);
  const uriRef = useRef(null);

  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [playError, setPlayError] = useState(null);

  useEffect(() => {
    volumeRef.current = volume;
    // Never unmute mid-prime; prime restores the volume itself when it is done.
    if (!owningPrimeRef.current) playerRef.current?.setVolume(volume).catch(() => {});
  }, [volume]);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        await loadSdk();
        if (disposed) return;

        const player = new window.Spotify.Player({
          name: "1Hub · Know Your Song",
          volume: volumeRef.current,
          getOAuthToken: (cb) => {
            getAccessToken().then(cb).catch(() => {});
          },
        });

        player.addListener("ready", ({ device_id }) => {
          deviceIdRef.current = device_id;
          // Claim the device so /play targets this tab rather than another client.
          transferPlayback(device_id)
            .catch(() => {})
            .finally(() => !disposed && setStatus("ready"));
        });

        player.addListener("not_ready", () => {
          deviceIdRef.current = null;
        });

        // The SDK swaps in a fresh media element when a track loads, which can
        // drop a volume set before the load. Re-clamp on every state change
        // while priming so nothing is ever audible before the first clip.
        player.addListener("player_state_changed", (state) => {
          if (disposed) return;
          if (owningPrimeRef.current) {
            // Mute unconditionally — silence comes from volume, not from
            // winning a race. Only pause once the SDK actually holds our
            // track; pausing mid-load fights the loader and it may never
            // finish loading at all.
            player.setVolume(0).catch(() => {});
            const uri = uriRef.current;
            if (uri && isOurs(state, uri) && !state?.paused) {
              player.pause().catch(() => {});
            }
            setPlaying(false);
            return;
          }
          setPlaying(!!state && !state.paused);
        });

        const fail = (fallback) => ({ message }) => {
          if (disposed) return;
          setError(message || fallback);
          setStatus("error");
        };

        player.addListener("initialization_error", fail("Player failed to start."));
        player.addListener("authentication_error", fail("Spotify rejected the session."));
        player.addListener(
          "account_error",
          fail("This needs a Spotify Premium account to play audio.")
        );

        playerRef.current = player;
        const connected = await player.connect();
        if (!connected && !disposed) {
          setError("The browser blocked playback. Try Chrome, and allow autoplay.");
          setStatus("error");
        }
      } catch (e) {
        if (!disposed) {
          setError(e instanceof Error ? e.message : String(e));
          setStatus("error");
        }
      }
    })();

    return () => {
      disposed = true;
      if (stopTimer.current) clearTimeout(stopTimer.current);
      playerRef.current?.disconnect();
      playerRef.current = null;
      deviceIdRef.current = null;
    };
  }, []);

  /**
   * Starts `uri` on our device, re-registering first if Spotify no longer
   * knows it. A device id goes stale whenever the SDK disconnects: a reload,
   * a hot update, Spotify dropping an idle Web Playback device, or another
   * tab of this app claiming playback. That surfaces as 404 "Device not found".
   */
  const playWithRecovery = useCallback(async (uri) => {
    const player = playerRef.current;
    if (!player) throw new Error("The player is not running.");

    const deviceId = deviceIdRef.current;
    if (deviceId) {
      try {
        await playTrack(deviceId, uri, 0);
        return;
      } catch {
        // Fall through and re-register; the id was probably stale.
      }
    }

    deviceIdRef.current = null;
    await player.connect().catch(() => {});
    await waitUntil(async () => deviceIdRef.current !== null, 10000);

    const fresh = deviceIdRef.current;
    if (!fresh) {
      throw new Error(
        "Lost the Spotify player device. Reload the page, and close any other tab running this game."
      );
    }
    await transferPlayback(fresh).catch(() => {});
    await playTrack(fresh, uri, 0);
  }, []);

  const halt = useCallback(async () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    setPlaying(false);
    const player = playerRef.current;
    if (!player) return;
    await player.pause().catch(() => {});
    await player.seek(0).catch(() => {});
  }, []);

  /**
   * Cues a track at 0:00, paused and silent, so a 0.1s clip can start instantly
   * without the track being audible while it loads.
   */
  const prime = useCallback(
    async (uri) => {
      const player = playerRef.current;
      if (!player) throw new Error("Player is not ready yet.");

      if (stopTimer.current) clearTimeout(stopTimer.current);
      const id = ++primeIdRef.current;
      owningPrimeRef.current = id;
      uriRef.current = uri;
      setPlayError(null);

      // A later prime has taken the player; this one must stop touching it.
      const superseded = () => primeIdRef.current !== id;

      try {
        await player.setVolume(0).catch(() => {});
        await playWithRecovery(uri);
        if (superseded()) return;

        // Wait for the SDK to actually load the track, without interfering.
        // It is inaudible throughout because the volume is 0. Give up early if
        // a newer prime has started: the device is loading *its* track now, so
        // this one would wait out the full budget and then report a track that
        // was never going to load as unplayable.
        const loaded = await waitUntil(
          async () => superseded() || isOurs(await player.getCurrentState(), uri),
          12000
        );
        if (superseded()) return;
        if (!loaded) {
          throw new Error(
            "Spotify never started this track — it may not be playable in your region."
          );
        }

        // It exists now, so pausing it is safe.
        await player.pause().catch(() => {});
        await waitUntil(async () => {
          const state = await player.getCurrentState();
          if (state && !state.paused) await player.pause().catch(() => {});
          return !!state?.paused;
        }, 3000);
        await player.seek(0).catch(() => {});
      } finally {
        // Only the prime that still owns the player restores the volume —
        // otherwise an older call unmutes the track a newer one is loading.
        if (!superseded()) {
          owningPrimeRef.current = 0;
          await player.setVolume(volumeRef.current).catch(() => {});
          setPlaying(false);
        }
      }
    },
    [playWithRecovery]
  );

  /**
   * Starts the cued track from 0:00.
   *
   * Prefers the SDK's local resume (fast, no network). Falls back to a fresh
   * play request when that does not take — which happens when the previous
   * round ran to the end of its context, or when Spotify has deactivated this
   * device for being idle. Errors surface instead of leaving a dead button.
   */
  const startFromZero = useCallback(async () => {
    const player = playerRef.current;
    const uri = uriRef.current;
    if (!player || !uri) return false;

    setPlayError(null);

    const isPlaying = async () => {
      const state = await player.getCurrentState();
      return isOurs(state, uri) && !state?.paused;
    };

    const state = await player.getCurrentState();
    if (isOurs(state, uri)) {
      await player.seek(0).catch(() => {});
      await player.resume().catch(() => {});
      if (await waitUntil(isPlaying, 1200)) return true;
    }

    try {
      await playWithRecovery(uri);
    } catch (e) {
      setPlayError(e instanceof Error ? e.message : String(e));
      return false;
    }

    if (await waitUntil(isPlaying, 5000)) return true;

    setPlayError("Spotify did not start playback. Try again, or reload the page.");
    return false;
  }, [playWithRecovery]);

  /** Plays the opening `seconds` of the cued track, then stops back at 0:00. */
  const playClip = useCallback(
    async (seconds) => {
      if (stopTimer.current) clearTimeout(stopTimer.current);
      const player = playerRef.current;
      if (!player) return;

      const started = await startFromZero();
      if (!started) return;
      setPlaying(true);

      // Timed from confirmed playback, so buffering does not eat the clip.
      stopTimer.current = setTimeout(() => {
        player.pause().catch(() => {});
        player.seek(0).catch(() => {});
        setPlaying(false);
      }, seconds * 1000);
    },
    [startFromZero]
  );

  /** Plays from the top at full length, for the reveal. */
  const playFull = useCallback(async () => {
    if (stopTimer.current) clearTimeout(stopTimer.current);
    stopTimer.current = null;
    if (await startFromZero()) setPlaying(true);
  }, [startFromZero]);

  return { status, error, playError, playing, prime, playClip, playFull, halt };
}
