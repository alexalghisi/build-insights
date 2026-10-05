import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { InsightsService } from "./gen/buildinsights/v1/insights_pb";
import { UsageService } from "./gen/buildinsights/v1/usage_pb";

export interface Api {
    readonly insights: Client<typeof InsightsService>;
    readonly usage: Client<typeof UsageService>;
}

export function apiFrom(transport: Transport): Api {
    return { insights: createClient(InsightsService, transport), usage: createClient(UsageService, transport) };
}

export function httpApi(baseUrl: string, token: string): Api {
    const auth: Interceptor = (next) => (req) => {
        req.header.set("authorization", `Bearer ${token}`);
        return next(req);
    };
    return apiFrom(createConnectTransport({ baseUrl, interceptors: [auth] }));
}
