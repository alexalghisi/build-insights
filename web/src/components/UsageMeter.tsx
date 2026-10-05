import { Code } from "@connectrpc/connect";
import type { GetUsageResponse } from "../gen/buildinsights/v1/usage_pb";
import { count, euros } from "../format";
import type { CallState } from "../useCall";

export function UsageMeter({ month, usage }: { readonly month: string; readonly usage: CallState<GetUsageResponse> }) {
    if (usage.status === "loading") return <section className="card usage" aria-busy="true" />;
    if (usage.status === "error") {
        const message = usage.error.code === Code.PermissionDenied ? "Usage needs a token with the billing:read scope." : usage.error.rawMessage;
        return (
            <section className="card usage">
                <h2>Build minutes · {month}</h2>
                <p className="muted">{message}</p>
            </section>
        );
    }
    const { buildMinutes, includedMinutes, overageMinutes, overageCents } = usage.data;
    const used = includedMinutes === 0 ? 1 : Math.min(1, buildMinutes / includedMinutes);
    return (
        <section className="card usage">
            <h2>Build minutes · {month}</h2>
            <p className="big">
                {count(buildMinutes)} <span className="muted">of {count(includedMinutes)} included</span>
            </p>
            <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={includedMinutes} aria-valuenow={buildMinutes} aria-label="Build minutes used">
                <div className={overageMinutes > 0 ? "over" : ""} style={{ width: `${used * 100}%` }} />
            </div>
            <p className="muted">{overageMinutes > 0 ? `${count(overageMinutes)} minutes over the plan: ${euros(overageCents)}` : "Within the plan"}</p>
        </section>
    );
}
