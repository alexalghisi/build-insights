import { createHash, randomBytes } from "node:crypto";

const PREFIX = "bi_";

/** Tokens carry a recognisable prefix so secret scanners can find leaked ones. */
export function generateToken(): string {
    return PREFIX + randomBytes(24).toString("base64url");
}

export function hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
}

export function looksLikeToken(value: string): boolean {
    return value.startsWith(PREFIX) && value.length === PREFIX.length + 32;
}

export function newId(prefix: string): string {
    return `${prefix}_${randomBytes(9).toString("base64url").replaceAll(/[-_]/g, "x")}`;
}
