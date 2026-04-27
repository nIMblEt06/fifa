const EMOJI = ["🔥", "😂", "💀", "👏", "🤝"];

export default function Reactions({ reactions, onSend }) {
  return (
    <>
      <div className="reaction-bar" role="toolbar" aria-label="Reactions">
        {EMOJI.map((e) => (
          <button key={e} onClick={() => onSend(e)} aria-label={`React ${e}`}>
            {e}
          </button>
        ))}
      </div>
      <div aria-hidden="true">
        {reactions.map((r) => (
          <span
            key={r.id}
            className="reaction-fly"
            style={{ left: r.left, bottom: "5rem" }}
          >
            {r.emoji}
          </span>
        ))}
      </div>
    </>
  );
}
