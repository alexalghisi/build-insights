import { StrictMode, useCallback, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { httpApi } from "./api";
import { Dashboard, TokenForm } from "./App";
import "./styles.css";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
const KEY = "build-insights-token";

function read(): string | null {
    try {
        return sessionStorage.getItem(KEY);
    } catch {
        return null;
    }
}

function write(token: string | null) {
    try {
        if (token === null) sessionStorage.removeItem(KEY);
        else sessionStorage.setItem(KEY, token);
    } catch {
        // storage unavailable: the token lives only in memory
    }
}

function Root() {
    const [token, setToken] = useState(read);
    const [error, setError] = useState<string>();
    const api = useMemo(() => (token ? httpApi(API_URL, token) : undefined), [token]);
    const signOut = useCallback((reason?: string) => {
        write(null);
        setToken(null);
        setError(reason);
    }, []);
    if (!api) {
        return (
            <TokenForm
                {...(error ? { error } : {})}
                onSubmit={(value) => {
                    write(value);
                    setError(undefined);
                    setToken(value);
                }}
            />
        );
    }
    return <Dashboard api={api} onSignOut={signOut} />;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");
createRoot(root).render(
    <StrictMode>
        <Root />
    </StrictMode>,
);
