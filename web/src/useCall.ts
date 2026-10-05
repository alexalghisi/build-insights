import { ConnectError } from "@connectrpc/connect";
import { useEffect, useState } from "react";

export type CallState<T> =
    | { readonly status: "loading" }
    | { readonly status: "error"; readonly error: ConnectError }
    | { readonly status: "done"; readonly data: T };

/** Runs an RPC when its inputs change. A response for inputs you've already moved on from is dropped. */
export function useCall<T>(call: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): CallState<T> {
    const [state, setState] = useState<CallState<T>>({ status: "loading" });
    useEffect(() => {
        const controller = new AbortController();
        setState({ status: "loading" });
        call(controller.signal).then(
            (data) => !controller.signal.aborted && setState({ status: "done", data }),
            (error: unknown) => !controller.signal.aborted && setState({ status: "error", error: ConnectError.from(error) }),
        );
        return () => controller.abort();
    }, deps);
    return state;
}
