export const NO_FILTERS = { decades: [], genres: [], popularity: [] };

/** How many genre chips to offer. Spotify's genre list is long and granular. */
const GENRE_LIMIT = 14;

export const POPULARITY_BANDS = [
  { id: "hits", label: "Hits", min: 70, max: 100 },
  { id: "mid", label: "Mid", min: 40, max: 69 },
  { id: "deep", label: "Deep cuts", min: 0, max: 39 },
];

export function decadeOf(track) {
  const year = Number(track.year);
  if (!Number.isFinite(year) || year < 1900) return null;
  return String(Math.floor(year / 10) * 10);
}

export function popularityOf(track) {
  const band = POPULARITY_BANDS.find(
    (b) => track.popularity >= b.min && track.popularity <= b.max
  );
  return band?.id ?? "deep";
}

function tally(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return counts;
}

/**
 * Derives the available chips from the library itself, so a filter is never
 * offered when nothing in the library would match it.
 */
export function buildFacets(tracks) {
  const decadeCounts = tally(tracks.map(decadeOf).filter((d) => d !== null));
  const decades = [...decadeCounts.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, count]) => ({ id, label: `${id.slice(2)}s`, count }));

  const genreCounts = tally(tracks.flatMap((t) => t.genres));
  const genres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, GENRE_LIMIT)
    .map(([id, count]) => ({ id, label: id, count }));

  const popCounts = tally(tracks.map(popularityOf));
  const popularity = POPULARITY_BANDS.map((b) => ({
    id: b.id,
    label: b.label,
    count: popCounts.get(b.id) ?? 0,
  })).filter((f) => f.count > 0);

  return { decades, genres, popularity };
}

function matches(track, filters) {
  // Within a group the chips are OR'd; across groups they are AND'd.
  if (filters.decades.length) {
    const d = decadeOf(track);
    if (!d || !filters.decades.includes(d)) return false;
  }
  if (filters.genres.length) {
    if (!track.genres.some((g) => filters.genres.includes(g))) return false;
  }
  if (filters.popularity.length) {
    if (!filters.popularity.includes(popularityOf(track))) return false;
  }
  return true;
}

export function applyFilters(tracks, filters) {
  if (!isActive(filters)) return tracks;
  return tracks.filter((t) => matches(t, filters));
}

export function isActive(filters) {
  return (
    filters.decades.length > 0 ||
    filters.genres.length > 0 ||
    filters.popularity.length > 0
  );
}

export function toggle(filters, group, id) {
  const current = filters[group];
  const next = current.includes(id)
    ? current.filter((x) => x !== id)
    : [...current, id];
  return { ...filters, [group]: next };
}

const KEY = "song.filters";

export function loadFilters() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return NO_FILTERS;
    return { ...NO_FILTERS, ...JSON.parse(raw) };
  } catch {
    return NO_FILTERS;
  }
}

export function saveFilters(filters) {
  try {
    localStorage.setItem(KEY, JSON.stringify(filters));
  } catch {
    // Filters are a convenience; failing to persist them is not worth an error.
  }
}
