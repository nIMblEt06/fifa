import { addToPlaylist } from "../utils/playlist";

// The ♡, in the two places it appears: on the marquee, and on the reveal card
// once a round is over.
//
// It is a one-shot action, not a toggle — the click puts the song in the
// player's Spotify playlist and the mark turns to ✓ for good. There is no
// un-like, because the song is in Spotify now; removing it belongs in Spotify.
export default function KeepButton({ track, inPlaylist, adding, big, clone }) {
  const label = inPlaylist
    ? `${track.name} is in your playlist`
    : adding
      ? `Adding ${track.name} to your playlist`
      : `Add ${track.name} to your playlist`;

  return (
    <button
      className={
        "song-mq-heart" +
        (big ? " big" : "") +
        (inPlaylist ? " done" : adding ? " busy" : "")
      }
      onClick={() => void addToPlaylist(track)}
      disabled={inPlaylist || adding}
      // The marquee renders its list twice to loop seamlessly; the copy must
      // not be a second tab stop for every control.
      tabIndex={clone ? -1 : undefined}
      aria-label={label}
      title={
        inPlaylist
          ? "In your playlist"
          : adding
            ? "Adding…"
            : "Add to your Spotify playlist"
      }
    >
      {inPlaylist ? "✓" : adding ? "·" : "♡"}
    </button>
  );
}
