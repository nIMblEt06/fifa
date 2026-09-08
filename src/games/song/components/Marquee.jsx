import { useEffect, useState } from "react";
import { REC_COUNT, fetchRecs } from "../utils/recs";
import KeepButton from "./KeepButton";

// A thin strip of the hub owner's Liked Songs, drifting past under the game.
//
// It is deliberately low-key: five songs, no playback, no scoreboard. The only
// thing it asks for is a ♡, which puts the song on the player's own list to
// turn into a playlist later. Nothing is added by it scrolling past.

function Item({ track, inPlaylist, adding, clone }) {
  return (
    <li className="song-mq-item" aria-hidden={clone || undefined}>
      {track.art ? <img src={track.art} alt="" /> : <span className="song-mq-blank" />}
      <span className="song-mq-text">
        <span className="song-mq-title">{track.name}</span>
        <span className="song-mq-artist">{track.artists}</span>
      </span>
      <KeepButton
        track={track}
        inPlaylist={inPlaylist}
        adding={adding}
        clone={clone}
      />
    </li>
  );
}

export default function Marquee({ genre, roundKey, playlistIds, adding }) {
  const [tracks, setTracks] = useState([]);

  useEffect(() => {
    let live = true;
    fetchRecs({ genre, n: REC_COUNT })
      .then((next) => live && next.length > 0 && setTracks(next))
      // No recommendations published, or the request failed: the strip is a
      // bonus, so it simply keeps whatever it last had — or stays absent.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [genre, roundKey]);

  if (tracks.length === 0) return null;

  const row = (clone) =>
    tracks.map((track) => (
      <Item
        key={(clone ? "b:" : "a:") + track.id}
        track={track}
        inPlaylist={playlistIds.has(track.id)}
        adding={adding.has(track.id)}
        clone={clone}
      />
    ));

  return (
    <section className="song-marquee" aria-label="Songs from the hub owner's library">
      <span className="song-mq-label">Also liked</span>
      <div className="song-mq-window">
        {/* The list is rendered twice and shifted by exactly half its width,
            so the loop has no seam. The clone is hidden from assistive tech. */}
        <ul className="song-mq-track">
          {row(false)}
          {row(true)}
        </ul>
      </div>
    </section>
  );
}
