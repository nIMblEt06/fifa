import { useEffect, useState, useMemo } from "react";

// Loads /teams.json once and exposes { teams, byName, loading }.
export function useTeams() {
  const [teams, setTeams] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch("/teams.json")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setTeams(Array.isArray(data) ? data : []);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const byName = useMemo(() => {
    const m = new Map();
    for (const t of teams) m.set(t.name, t);
    return m;
  }, [teams]);

  return { teams, byName, loading };
}
