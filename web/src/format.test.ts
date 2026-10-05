import { count, currentMonth, duration, euros, percent } from "./format";

describe("format", () => {
    it("formats durations for humans", () => {
        expect(duration(3_840)).toBe("3.8s");
        expect(duration(116_900)).toBe("1m 57s");
        expect(duration(119_700)).toBe("2m 0s");
    });

    it("formats ratios, counts, money and months", () => {
        expect(percent(0.734)).toBe("73%");
        expect(count(12_345)).toBe("12,345");
        expect(euros(924)).toBe("€9.24");
        expect(currentMonth(new Date("2026-10-05T12:00:00Z"))).toBe("2026-10");
    });
});
