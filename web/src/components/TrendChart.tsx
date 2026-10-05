import type { DailyPoint } from "../gen/buildinsights/v1/insights_pb";
import { duration, percent } from "../format";

const W = 1000;
const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 70 };

/** Daily p50 and p95 build time (wall clock), with the cache hit rate underneath. */
export function TrendChart({ days }: { readonly days: readonly DailyPoint[] }) {
    if (days.length === 0) return <p className="empty">No builds in this window yet.</p>;
    const max = Math.ceil((Math.max(...days.map((d) => d.p95BuildMs)) * 1.1) / 60_000) * 60_000;
    const x = (i: number) => PAD.left + (days.length === 1 ? 0 : (i / (days.length - 1)) * (W - PAD.left - PAD.right));
    const y = (ms: number) => PAD.top + (1 - ms / max) * (H - PAD.top - PAD.bottom);
    const line = (pick: (d: DailyPoint) => number) => days.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`).join(" ");
    const ticks = [0, max / 2, max];
    const first = days[0];
    const last = days[days.length - 1];

    return (
        <figure className="trend">
            <figcaption>
                Build time per day
                {first && last && (
                    <span className="delta">
                        p95 {duration(first.p95BuildMs)} → {duration(last.p95BuildMs)} · cache hits {percent(first.cacheHitRate)} → {percent(last.cacheHitRate)}
                    </span>
                )}
            </figcaption>
            <svg viewBox={`0 0 ${W} ${H + 40}`} role="img" aria-label={`Daily p50 and p95 build time over ${days.length} days`}>
                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
                        <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="tick">
                            {duration(t)}
                        </text>
                    </g>
                ))}
                <text x={PAD.left - 6} y={H + 22} textAnchor="end" className="tick">
                    cache hits
                </text>
                <path d={line((d) => d.p95BuildMs)} className="line p95" />
                <path d={line((d) => d.p50BuildMs)} className="line p50" />
                {days.map((d, i) => (
                    <g key={d.day}>
                        <rect x={x(i) - 3} y={H + 4 + (1 - d.cacheHitRate) * 28} width={6} height={d.cacheHitRate * 28} className="hits">
                            <title>{`${d.day}: ${d.builds} builds, p50 ${duration(d.p50BuildMs)}, p95 ${duration(d.p95BuildMs)}, cache hits ${percent(d.cacheHitRate)}`}</title>
                        </rect>
                        {(i === 0 || i === days.length - 1 || i % 7 === 0) && (
                            <text x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} className="tick">
                                {d.day.slice(5)}
                            </text>
                        )}
                    </g>
                ))}
            </svg>
            <ul className="legend">
                <li className="p95">p95</li>
                <li className="p50">p50</li>
                <li className="hits">cache hit rate</li>
            </ul>
        </figure>
    );
}
