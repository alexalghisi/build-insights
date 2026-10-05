import { describe, expect, it } from "vitest";
import { bill, isMonth } from "../src/billing.ts";

describe("bill", () => {
    const plan = { includedMinutes: 500, overageCentsPerMinute: 4 };

    it("charges nothing within the included minutes", () => {
        expect(bill(500, plan)).toEqual({ buildMinutes: 500, includedMinutes: 500, overageMinutes: 0, overageCents: 0 });
    });

    it("charges overage per minute beyond the plan", () => {
        expect(bill(731, plan)).toMatchObject({ overageMinutes: 231, overageCents: 924 });
    });
});

describe("isMonth", () => {
    it("accepts YYYY-MM only", () => {
        expect(["2026-10", "2026-01"].every(isMonth)).toBe(true);
        expect(["2026-13", "2026-1", "26-10", "2026-10-01", ""].some(isMonth)).toBe(false);
    });
});
