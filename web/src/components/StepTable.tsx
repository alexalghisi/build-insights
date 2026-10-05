import type { StepStats } from "../gen/buildinsights/v1/insights_pb";
import { duration, percent } from "../format";

/** Steps ordered by total time, with p50 and p95 on one shared scale so the slowest tails stand out. */
export function StepTable({ steps }: { readonly steps: readonly StepStats[] }) {
    const longest = Math.max(1, ...steps.map((s) => s.p95Ms));
    return (
        <table className="steps">
            <caption>Where build time goes</caption>
            <thead>
                <tr>
                    <th scope="col">Step</th>
                    <th scope="col">Share of time</th>
                    <th scope="col">p50 / p95</th>
                    <th scope="col" className="num">
                        Cache hits
                    </th>
                    <th scope="col" className="num">
                        Runs
                    </th>
                </tr>
            </thead>
            <tbody>
                {steps.map((step) => (
                    <tr key={step.name}>
                        <th scope="row">{step.name}</th>
                        <td>
                            <div className="bar share" style={{ width: percent(step.shareOfTime) }} />
                            <span className="label">{percent(step.shareOfTime)}</span>
                        </td>
                        <td>
                            <div className="range" title={`p50 ${duration(step.p50Ms)}, p95 ${duration(step.p95Ms)}`}>
                                <div className="bar p95" style={{ width: `${(step.p95Ms / longest) * 100}%` }} />
                                <div className="bar p50" style={{ width: `${(step.p50Ms / longest) * 100}%` }} />
                            </div>
                            <span className="label">
                                {duration(step.p50Ms)} / {duration(step.p95Ms)}
                            </span>
                        </td>
                        <td className={`num${step.cacheHitRate >= 0.8 ? " good" : step.cacheHitRate > 0 && step.cacheHitRate < 0.5 ? " warn" : ""}`}>
                            {step.cacheHitRate > 0 ? percent(step.cacheHitRate) : "–"}
                        </td>
                        <td className="num">{step.runs}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}
