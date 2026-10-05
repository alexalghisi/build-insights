export function duration(ms: number): string {
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.round((ms % 60_000) / 1_000);
    return seconds === 60 ? `${minutes + 1}m 0s` : `${minutes}m ${seconds}s`;
}

export const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;

export const count = (n: number) => new Intl.NumberFormat("en-GB").format(n);

export const euros = (cents: number) => new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(cents / 100);

export function currentMonth(now = new Date()): string {
    return now.toISOString().slice(0, 7);
}
