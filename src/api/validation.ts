import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { StepRow } from "../analytics/StepsRepo.ts";
import type { ReportBuildRequest } from "../gen/buildinsights/v1/ingest_pb.ts";

export const LIMITS = {
    maxSteps: 500,
    maxStepNameLength: 200,
    maxGitRefLength: 255,
    maxDurationMs: 24 * 3_600_000,
    retentionDays: 90,
    clockSkewMs: 3_600_000,
} as const;

const BUILD_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Checks a report and converts it, or throws invalid_argument listing every problem with its field path. */
export function validateReport(req: ReportBuildRequest, now = new Date()): StepRow[] {
    const problems: string[] = [];
    if (!BUILD_ID.test(req.buildId)) problems.push("build_id: 1-128 characters from A-Z a-z 0-9 . _ : -");
    if (req.gitRef.length > LIMITS.maxGitRefLength) problems.push(`git_ref: at most ${LIMITS.maxGitRefLength} characters`);
    if (req.steps.length === 0) problems.push("steps: at least one step is required");
    if (req.steps.length > LIMITS.maxSteps) problems.push(`steps: at most ${LIMITS.maxSteps} steps per build`);

    const oldest = now.getTime() - LIMITS.retentionDays * 86_400_000;
    const latest = now.getTime() + LIMITS.clockSkewMs;
    const rows: StepRow[] = [];
    req.steps.slice(0, LIMITS.maxSteps).forEach((step, i) => {
        const at = `steps[${i}]`;
        const name = step.name.trim();
        if (name === "" || name.length > LIMITS.maxStepNameLength) problems.push(`${at}.name: 1-${LIMITS.maxStepNameLength} characters`);
        if (step.durationMs > LIMITS.maxDurationMs) problems.push(`${at}.duration_ms: at most ${LIMITS.maxDurationMs}`);
        if (step.startedAt === undefined) {
            problems.push(`${at}.started_at: required`);
            return;
        }
        const startedAt = timestampDate(step.startedAt);
        if (startedAt.getTime() < oldest) problems.push(`${at}.started_at: older than the ${LIMITS.retentionDays}-day retention`);
        if (startedAt.getTime() > latest) problems.push(`${at}.started_at: in the future`);
        rows.push({ name, startedAt, durationMs: step.durationMs, cached: step.cached, exitCode: step.exitCode });
    });

    if (problems.length > 0) {
        const shown = problems.slice(0, 10).join("; ");
        throw new ConnectError(`Invalid build report: ${shown}${problems.length > 10 ? ` (and ${problems.length - 10} more)` : ""}`, Code.InvalidArgument);
    }
    return rows;
}
