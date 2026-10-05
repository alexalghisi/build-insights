import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { authInterceptor } from "./api/auth.ts";
import { routes, type Deps } from "./api/routes.ts";

export interface ServerOptions extends Deps {
    /** Origin allowed to call the API from a browser (the console), if any. */
    readonly corsOrigin?: string;
}

export function createApiServer(options: ServerOptions): Server {
    const handler = connectNodeAdapter({ routes: routes(options), interceptors: [authInterceptor(options.accounts)] });
    return createServer((req: IncomingMessage, res: ServerResponse) => {
        if (options.corsOrigin !== undefined && req.headers.origin === options.corsOrigin) {
            res.setHeader("Access-Control-Allow-Origin", options.corsOrigin);
            res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, connect-protocol-version, connect-timeout-ms");
            res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
            res.setHeader("Vary", "Origin");
            if (req.method === "OPTIONS") {
                res.writeHead(204).end();
                return;
            }
        }
        if (req.url === "/healthz") {
            res.writeHead(200, { "content-type": "text/plain" }).end("ok");
            return;
        }
        handler(req, res);
    });
}
