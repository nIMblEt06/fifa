export default function Marquee({ items }) {
  if (!items || items.length === 0) return null;
  // Duplicate so the scroll loop is continuous
  const loop = [...items, ...items];
  return (
    <div className="marquee" aria-hidden="true">
      <div className="marquee-track">
        {loop.map((text, i) => (
          <span key={i} className="marquee-item">{text}</span>
        ))}
      </div>
    </div>
  );
}
