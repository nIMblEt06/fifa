// Landing page when no room is in the URL. Picks a game; we mint a code
// and route to it.
export default function GamePicker({ onPick, onOpenHof }) {
  const games = [
    {
      id: "fifa",
      title: "FIFA",
      tagline: "TOURNAMENT",
      blurb: "Group stage + knockout. Pick teams, scrap for the top 4.",
    },
    {
      id: "lit",
      title: "LIT",
      tagline: "FOUR-OF-A-KIND",
      blurb: "Local Go-Fish variant. Ask for ranks you hold, hunt the deck for full sets.",
    },
    {
      id: "poker",
      title: "POKER",
      tagline: "CASH GAME",
      blurb: "Poker-night buy-in tracker. Count the chips, settle the net to Splitwise.",
    },
  ];

  return (
    <div className="app">
      <header className="masthead">
        <h1>
          <span className="slash">1</span>Hub
        </h1>
      </header>
      <main>
        <div className="game-picker">
          {games.map((g) => (
            <button key={g.id} className="game-tile" onClick={() => onPick(g.id)}>
              <div className="game-tile-title">
                {g.title}
                <span className="slash">/</span>
                <span className="game-tile-sub">{g.tagline}</span>
              </div>
              <div className="game-tile-blurb">{g.blurb}</div>
              <div className="game-tile-cta">NEW ROOM →</div>
            </button>
          ))}
          {onOpenHof && (
            <button className="game-tile hof-tile" onClick={onOpenHof}>
              <div className="game-tile-title">
                HALL<span className="slash">/</span><span className="game-tile-sub">OF FAME</span>
              </div>
              <div className="game-tile-blurb">All-time FIFA stats: championships, leaderboards, head-to-head.</div>
              <div className="game-tile-cta">BROWSE →</div>
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
