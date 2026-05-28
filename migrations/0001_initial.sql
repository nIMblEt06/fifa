-- Hall-of-Fame schema for FIFA tournament history.
-- Career stats are computed by aggregating tournament_participants + matches.

CREATE TABLE players (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL UNIQUE,
  created_at      INTEGER NOT NULL
);

CREATE TABLE tournaments (
  id                 TEXT PRIMARY KEY,
  room_code          TEXT NOT NULL,
  format             TEXT NOT NULL,
  num_players        INTEGER NOT NULL,
  group_rounds       INTEGER,
  qualifiers         INTEGER,
  matches_per_player INTEGER,
  started_at         INTEGER,
  ended_at           INTEGER NOT NULL,
  champion_id        INTEGER REFERENCES players(id),
  runner_up_id       INTEGER REFERENCES players(id),
  UNIQUE (room_code, ended_at)
);

CREATE TABLE tournament_participants (
  tournament_id TEXT    NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  player_id     INTEGER NOT NULL REFERENCES players(id),
  team_name     TEXT,
  final_rank    INTEGER,
  group_id      TEXT,
  wins          INTEGER NOT NULL DEFAULT 0,
  draws         INTEGER NOT NULL DEFAULT 0,
  losses        INTEGER NOT NULL DEFAULT 0,
  goals_for     INTEGER NOT NULL DEFAULT 0,
  goals_against INTEGER NOT NULL DEFAULT 0,
  reached_stage TEXT,
  PRIMARY KEY (tournament_id, player_id)
);

CREATE TABLE matches (
  id            TEXT PRIMARY KEY,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage         TEXT NOT NULL,
  group_id      TEXT,
  home_id       INTEGER REFERENCES players(id),
  away_id       INTEGER REFERENCES players(id),
  home_team     TEXT,
  away_team     TEXT,
  home_score    INTEGER NOT NULL,
  away_score    INTEGER NOT NULL,
  played_at     INTEGER
);

CREATE INDEX idx_participants_player ON tournament_participants(player_id);
CREATE INDEX idx_matches_tournament  ON matches(tournament_id);
CREATE INDEX idx_matches_home        ON matches(home_id);
CREATE INDEX idx_matches_away        ON matches(away_id);
CREATE INDEX idx_tournaments_ended   ON tournaments(ended_at DESC);
