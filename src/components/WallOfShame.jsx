export default function WallOfShame({ entries }) {
  return (
    <section className="shame">
      <div className="shame-head">Wall of Shame</div>
      {entries.length === 0 ? (
        <div className="shame-empty">No-one has embarrassed themselves yet.</div>
      ) : (
        <ul className="shame-list">
          {entries.map((e, i) => (
            <li key={i}>
              <div>
                <div className="label-text">{e.label}</div>
                <div className="victim">{e.victim}</div>
              </div>
              <div>{e.detail}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
