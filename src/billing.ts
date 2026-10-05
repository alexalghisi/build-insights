export interface Plan {
    readonly includedMinutes: number;
    readonly overageCentsPerMinute: number;
}

export interface Bill {
    readonly buildMinutes: number;
    readonly includedMinutes: number;
    readonly overageMinutes: number;
    readonly overageCents: number;
}

export function bill(buildMinutes: number, plan: Plan): Bill {
    const overageMinutes = Math.max(0, buildMinutes - plan.includedMinutes);
    return {
        buildMinutes,
        includedMinutes: plan.includedMinutes,
        overageMinutes,
        overageCents: overageMinutes * plan.overageCentsPerMinute,
    };
}

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonth(value: string): boolean {
    return MONTH.test(value);
}
