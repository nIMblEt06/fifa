// Fuzzy identity for tracks: the same song saved twice (a remaster, a reissue,
// a single and its album cut) has to compare equal, because naming the song is
// the point of the game.

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function fold(s) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const QUALIFIER =
  "remaster(?:ed)?|re-?recorded|live|acoustic|mono|stereo|radio edit|single version|album version|deluxe|bonus track|anniversary|edition|version|edit|mix|remix|instrumental|demo";

/**
 * Strips release-variant suffixes so the same song saved twice compares equal:
 * "When the Levee Breaks - Remaster" and "When the Levee Breaks" are one song.
 */
export function baseTitle(name) {
  let s = name;
  // " - 2007 Remaster", " - Live at Wembley", " - Radio Edit", …
  s = s.replace(
    new RegExp(`\\s*[-–—]\\s*(?:\\d{4}\\s*)?(?:${QUALIFIER})\\b.*$`, "i"),
    ""
  );
  // "(Remastered 2009)", "[Live]", "(Deluxe Edition)", …
  s = s.replace(
    new RegExp(`\\s*[([][^)\\]]*(?:${QUALIFIER})[^)\\]]*[)\\]]\\s*$`, "i"),
    ""
  );
  return fold(s);
}

/** Identity of a song across duplicate saves: base title + primary artist. */
export function songKey(track) {
  const artist = track.artistIds[0] ?? fold(track.artists);
  return `${artist}::${baseTitle(track.name)}`;
}

export function sharesArtist(a, b) {
  const ids = new Set(b.artistIds);
  return a.artistIds.some((id) => ids.has(id));
}

/**
 * True when two tracks are the same song, even as different Spotify releases
 * (remaster, deluxe reissue, a single and its album cut).
 */
export function sameSong(a, b) {
  if (a.id === b.id) return true;
  return baseTitle(a.name) === baseTitle(b.name) && sharesArtist(a, b);
}
