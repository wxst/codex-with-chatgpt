import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { AuthStore } from "./store.js";
import type { Logger } from "../logger/index.js";
import { OPENAI_TUNNEL_HEADER } from "../tunnel/transport-mode.js";

export const READ_ONLY_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
] as const;

export interface BearerAuthDeps {
  store: AuthStore;
  workspaceId: string;
  getBaseUrl: (req: Request) => string;
  logger: Logger;
}

/**
 * Bearer-token guard for /mcp.
 * - missing/invalid/expired token  -> 401 (+ WWW-Authenticate with resource metadata)
 * - valid token for another workspace -> 403
 */
export function bearerAuth(deps: BearerAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const challenge = (error: string, description: string): string =>
      `Bearer realm="c2c", error="${error}", error_description="${description}", ` +
      `resource_metadata="${deps.getBaseUrl(req)}/.well-known/oauth-protected-resource/mcp"`;

    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", "Missing bearer token"))
        .json({ error: "unauthorized", error_description: "Authentication required" });
      return;
    }
    const token = header.slice(7).trim();
    const verdict = deps.store.verifyAccessToken(token);
    if (!verdict.ok) {
      deps.logger.warn(`Rejected MCP request: token ${verdict.reason}`);
      res
        .status(401)
        .set("WWW-Authenticate", challenge("invalid_token", `Token ${verdict.reason}`))
        .json({ error: "unauthorized", error_description: `Token ${verdict.reason}` });
      return;
    }
    if (verdict.record.workspaceId !== deps.workspaceId) {
      deps.logger.warn("Rejected MCP request: token bound to a different workspace");
      res.status(403).json({
        error: "forbidden",
        error_description: "This token is not authorized for the connected workspace",
      });
      return;
    }
    const authInfo: AuthInfo = {
      token,
      clientId: verdict.record.clientId,
      scopes: verdict.record.scopes,
      expiresAt: Math.floor(verdict.record.expiresAt / 1000),
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}

export interface OpenAITunnelAuthDeps {
  expectedToken: string;
  logger: Logger;
}

const PROXY_MARKER_HEADERS = [
  "cf-connecting-ip",
  "forwarded",
  "x-forwarded-for",
  "x-real-ip",
] as const;

function isLoopback(remoteAddress: string): boolean {
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Authentication for OpenAI Secure MCP Tunnel mode.
 *
 * The MCP listener remains loopback-only. tunnel-client adds a per-workspace
 * static header whose value comes from a mode-0600 local file. We also reject
 * proxy-marker headers so accidentally routing this endpoint through a public
 * reverse proxy cannot downgrade it into a remotely reachable service.
 */
export function openAITunnelAuth(deps: OpenAITunnelAuthDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const hasProxyMarker = PROXY_MARKER_HEADERS.some((name) => req.headers[name] !== undefined);
    const supplied = req.get(OPENAI_TUNNEL_HEADER) ?? "";
    const loopback = isLoopback(remote);
    const tokenMatch = secureEqual(supplied, deps.expectedToken);

    if (!loopback || hasProxyMarker || !tokenMatch) {
      deps.logger.warn("Rejected MCP request in OpenAI tunnel mode", {
        loopback,
        proxyMarker: hasProxyMarker,
        tokenMatch,
      });
      res.status(401).json({ error: "unauthorized", error_description: "Trusted tunnel authentication required" });
      return;
    }

    const authInfo: AuthInfo = {
      token: "c2c-openai-secure-tunnel",
      clientId: "openai-secure-mcp-tunnel",
      scopes: [...READ_ONLY_SCOPES],
    };
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    next();
  };
}
