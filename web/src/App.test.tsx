import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { apiFrom } from "./api";
import { Dashboard, TokenForm } from "./App";
import { InsightsService } from "./gen/buildinsights/v1/insights_pb";
import { UsageService } from "./gen/buildinsights/v1/usage_pb";

const PROJECTS = [
    { id: "prj_api", name: "api", orgId: "org_acme" },
    { id: "prj_web", name: "web", orgId: "org_acme" },
];

function fakeApi(options: { usageDenied?: boolean; unauthenticated?: boolean } = {}) {
    const calls: string[] = [];
    const transport = createRouterTransport(({ service }) => {
        service(InsightsService, {
            listProjects() {
                if (options.unauthenticated) throw new ConnectError("Invalid or revoked API token", Code.Unauthenticated);
                return { projects: PROJECTS };
            },
            getStepStats(req) {
                calls.push(`stats ${req.projectId} ${req.windowDays}`);
                return {
                    builds: req.projectId === "prj_api" ? 291 : 120,
                    steps: [
                        { name: "e2e tests", runs: 291, p50Ms: 92_000, p95Ms: 116_900, cacheHitRate: 0, shareOfTime: 0.42 },
                        { name: "install dependencies", runs: 291, p50Ms: 3_800, p95Ms: 101_000, cacheHitRate: 0.73, shareOfTime: 0.12 },
                    ],
                };
            },
            getTrend() {
                return {
                    days: [
                        { day: "2026-10-04", builds: 20, p50BuildMs: 180_000, p95BuildMs: 260_000, cacheHitRate: 0.41 },
                        { day: "2026-10-05", builds: 18, p50BuildMs: 150_000, p95BuildMs: 190_000, cacheHitRate: 0.62 },
                    ],
                };
            },
        });
        service(UsageService, {
            getUsage() {
                if (options.usageDenied) throw new ConnectError("This token doesn't have the billing:read scope", Code.PermissionDenied);
                return { buildMinutes: 6_231, includedMinutes: 6_000, overageMinutes: 231, overageCents: 231, days: [] };
            },
        });
    });
    return { api: apiFrom(transport), calls };
}

describe("Dashboard", () => {
    it("shows where build time goes for the first project", async () => {
        render(<Dashboard api={fakeApi().api} onSignOut={() => {}} />);
        const table = await screen.findByRole("table", { name: "Where build time goes" });
        const rows = within(table).getAllByRole("row").slice(1);
        expect(rows.map((r) => within(r).getByRole("rowheader").textContent)).toEqual(["e2e tests", "install dependencies"]);
        expect(within(rows[1] as HTMLElement).getByText("3.8s / 1m 41s")).toBeInTheDocument();
        expect(within(rows[1] as HTMLElement).getByText("73%")).toBeInTheDocument();
        expect(screen.getByText("291", { selector: ".big" })).toBeInTheDocument();
        expect(screen.getByText(/231 minutes over the plan: €2.31/)).toBeInTheDocument();
        expect(screen.getByText(/p95 4m 20s → 3m 10s · cache hits 41% → 62%/)).toBeInTheDocument();
    });

    it("reloads when the project or window changes", async () => {
        const { api, calls } = fakeApi();
        render(<Dashboard api={api} onSignOut={() => {}} />);
        await screen.findByText("291", { selector: ".big" });
        await userEvent.click(screen.getByRole("button", { name: "web" }));
        await screen.findByText("120", { selector: ".big" });
        await userEvent.selectOptions(screen.getByRole("combobox"), "30");
        await waitFor(() => expect(calls).toContain("stats prj_web 30"));
        expect(calls[0]).toBe("stats prj_api 14");
    });

    it("explains a missing billing scope instead of failing", async () => {
        render(<Dashboard api={fakeApi({ usageDenied: true }).api} onSignOut={() => {}} />);
        expect(await screen.findByText("Usage needs a token with the billing:read scope.")).toBeInTheDocument();
        expect(await screen.findByRole("table")).toBeInTheDocument();
    });

    it("signs out when the token is rejected", async () => {
        const onSignOut = vi.fn();
        render(<Dashboard api={fakeApi({ unauthenticated: true }).api} onSignOut={onSignOut} />);
        await waitFor(() => expect(onSignOut).toHaveBeenCalledWith("Invalid or revoked API token"));
    });
});

describe("TokenForm", () => {
    it("submits a trimmed token and shows why the last one failed", async () => {
        const onSubmit = vi.fn();
        render(<TokenForm onSubmit={onSubmit} error="Invalid or revoked API token" />);
        expect(screen.getByRole("alert")).toHaveTextContent("Invalid or revoked API token");
        await userEvent.type(screen.getByLabelText(/API token/), "  bi_abc  ");
        await userEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
        expect(onSubmit).toHaveBeenCalledWith("bi_abc");
    });
});
