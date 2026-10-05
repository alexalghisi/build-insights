import { Code } from "@connectrpc/connect";
import { useEffect, useState, type FormEvent } from "react";
import type { Api } from "./api";
import type { Project } from "./gen/buildinsights/v1/insights_pb";
import { StepTable } from "./components/StepTable";
import { TrendChart } from "./components/TrendChart";
import { UsageMeter } from "./components/UsageMeter";
import { currentMonth, duration, percent } from "./format";
import { useCall } from "./useCall";

const WINDOWS = [7, 14, 30] as const;

export function TokenForm({ onSubmit, error }: { readonly onSubmit: (token: string) => void; readonly error?: string }) {
    const [value, setValue] = useState("");
    const submit = (event: FormEvent) => {
        event.preventDefault();
        if (value.trim() !== "") onSubmit(value.trim());
    };
    return (
        <form className="signin" onSubmit={submit}>
            <h1>Build insights</h1>
            <label htmlFor="token">API token with the insights:read scope</label>
            <input id="token" type="password" autoComplete="off" value={value} onChange={(e) => setValue(e.target.value)} placeholder="bi_…" />
            {error && (
                <p role="alert" className="error">
                    {error}
                </p>
            )}
            <button type="submit">Open dashboard</button>
            <p className="muted">The token stays in this tab's session storage and is sent only to the API.</p>
        </form>
    );
}

export function Dashboard({ api, onSignOut }: { readonly api: Api; readonly onSignOut: (reason?: string) => void }) {
    const [projectId, setProjectId] = useState<string>();
    const [windowDays, setWindowDays] = useState<number>(14);
    const projects = useCall((signal) => api.insights.listProjects({}, { signal }), [api]);

    useEffect(() => {
        if (projects.status === "error" && projects.error.code === Code.Unauthenticated) onSignOut(projects.error.rawMessage);
    }, [projects, onSignOut]);

    if (projects.status === "error") return <p role="alert">Couldn't load projects: {projects.error.rawMessage}</p>;
    const list = projects.status === "done" ? projects.data.projects : [];
    const project = list.find((p) => p.id === projectId) ?? list[0];

    return (
        <div className="dashboard">
            <header>
                <h1>Build insights</h1>
                <nav aria-label="Projects">
                    {list.map((p) => (
                        <button key={p.id} type="button" aria-pressed={p.id === project?.id} onClick={() => setProjectId(p.id)}>
                            {p.name}
                        </button>
                    ))}
                </nav>
                <label className="window">
                    Last
                    <select value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
                        {WINDOWS.map((w) => (
                            <option key={w} value={w}>
                                {w} days
                            </option>
                        ))}
                    </select>
                </label>
                <button type="button" className="link" onClick={() => onSignOut()}>
                    Sign out
                </button>
            </header>
            {project ? <ProjectView api={api} project={project} windowDays={windowDays} /> : projects.status === "done" && <p className="empty">No projects yet.</p>}
        </div>
    );
}

function ProjectView({ api, project, windowDays }: { readonly api: Api; readonly project: Project; readonly windowDays: number }) {
    const month = currentMonth();
    const stats = useCall((signal) => api.insights.getStepStats({ projectId: project.id, windowDays }, { signal }), [api, project.id, windowDays]);
    const trend = useCall((signal) => api.insights.getTrend({ projectId: project.id, windowDays }, { signal }), [api, project.id, windowDays]);
    const usage = useCall((signal) => api.usage.getUsage({ orgId: project.orgId, month }, { signal }), [api, project.orgId, month]);
    const days = trend.status === "done" ? trend.data.days : [];
    const latest = days[days.length - 1];

    return (
        <>
            <div className="cards">
                <section className="card">
                    <h2>Builds</h2>
                    <p className="big">{stats.status === "done" ? stats.data.builds : "…"}</p>
                    <p className="muted">last {windowDays} days</p>
                </section>
                <section className="card">
                    <h2>Build time today</h2>
                    <p className="big">{latest ? duration(latest.p50BuildMs) : "…"}</p>
                    <p className="muted">{latest ? `p95 ${duration(latest.p95BuildMs)}` : ""}</p>
                </section>
                <section className="card">
                    <h2>Cache hits today</h2>
                    <p className="big">{latest ? percent(latest.cacheHitRate) : "…"}</p>
                    <p className="muted">of all steps</p>
                </section>
                <UsageMeter month={month} usage={usage} />
            </div>
            {trend.status === "error" ? <p role="alert">{trend.error.rawMessage}</p> : <TrendChart days={days} />}
            {stats.status === "error" ? <p role="alert">{stats.error.rawMessage}</p> : stats.status === "done" && <StepTable steps={stats.data.steps} />}
        </>
    );
}
