import express, { type Request, type Response, type NextFunction } from "express";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import { Workspace } from "../workspace/manager.js";
import { AuthStore } from "../auth/store.js";
import { createOAuthRouter } from "../auth/oauth.js";
import { bearerAuth, openAITunnelAuth } from "../auth/middleware.js";
import { PairingManager } from "../pairing/manager.js";
import { createMcpServer } from "../mcp/server.js";
import { createMcpHttpHandler } from "../mcp/http.js";
import { CloudflaredQuickTunnel } from "../tunnel/cloudflared.js";
import { CloudflaredNamedTunnel } from "../tunnel/cloudflared-named.js";
import type { TunnelProvider } from "../tunnel/provider.js";
import { namedTunnelBinding, readTunnelState } from "../tunnel/state.js";
import { ensureOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Logger, nullLogger } from "../logger/index.js";
import { DEFAULT_HOST, DEFAULT_PORT } from "../config/paths.js";
import {
  processGenerationStatus,
  requireCurrentProcessGeneration,
  requireProcessSafetyRuntime,
} from "../process/process-identity.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import {
  cancelPendingStart,
  completePendingStart,
  requirePendingStart,
} from "../process/startup-registry.js";
import { SERVICE_NAME, VERSION } from "../version.js";
import {
  listRuntimeStates,
  removeRuntimeStateGeneration,
  writeRuntimeState,
  type RuntimeState,
} from "./runtime.js";

const activePersistedBridges = new Set<string>();
const PENDING_START_ENV = "C2C_PENDING_START_ID";

interface RuntimeIdentityPayload {
  service?: string;
  workspaceId?: string;
  pid?: number;
  processGeneration?: string | null;
  port?: number;
  startedAt?: string;
}

async function fetchLocalJson<T>(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function exactRuntimeIdentityMatches(runtime: RuntimeState, info: RuntimeIdentityPayload): boolean {
  return (
    info.service === SERVICE_NAME &&
    info.workspaceId === runtime.workspaceId &&
    info.pid === runtime.pid &&
    info.port === runtime.port &&
    info.startedAt === runtime.startedAt &&
    (!runtime.processGeneration || info.processGeneration === runtime.processGeneration)
  );
}

async function persistedRuntimeIsLiveBridge(runtime: RuntimeState): Promise<boolean> {
  const base = `http://127.0.0.1:${runtime.port}`;
  const info = await fetchLocalJson<RuntimeIdentityPayload>(`${base}/admin/info`, 1500, {
    Authorization: `Bearer ${runtime.adminToken}`,
  });
  if (info && exactRuntimeIdentityMatches(runtime, info)) return true;

  const health = await fetchLocalJson<{ service?: string; workspaceId?: string }>(`${base}/health`, 1000);
  return health?.service === SERVICE_NAME && health.workspaceId === runtime.workspaceId;
}

/**
 * Refuse a second persisted Bridge whenever an existing runtime may still own
 * credentials. Generation-bearing runtimes use exact OS identity before any
 * endpoint probe: `match` proves a live Bridge process and `unknown` fails
 * closed. A generationless compatibility snapshot cannot safely claim process
 * ownership from a reusable numeric PID, so it remains governed by exact
 * authenticated application identity plus the conservative workspace health
 * fallback. Only positively dead or unrelated state may permit startup.
 */
async function assertNoActivePersistedBridge(workspace: Workspace): Promise<void> {
  if (activePersistedBridges.has(workspace.id)) {
    throw new Error(`A persisted bridge is already running for workspace ${workspace.id}`);
  }

  for (const existing of listRuntimeStates(workspace.id)) {
    if (existing.processGeneration) {
      const generation = processGenerationStatus(existing.pid, existing.processGeneration);
      if (generation === "match") {
        throw new Error(`A persisted bridge process is already active for workspace ${workspace.id}`);
      }
      if (generation === "unknown") {
        throw new Error(`A persisted bridge process may still be active for workspace ${workspace.id}`);
      }
    }

    if (await persistedRuntimeIsLiveBridge(existing)) {
      throw new Error(`A persisted bridge runtime is already active for workspace ${workspace.id}`);
    }
  }
}

function tunnelForWorkspace(workspaceId: string, logger: Logger): TunnelProvider {
  const binding = namedTunnelBinding(readTunnelState(workspaceId));
  if (binding) {
    return new CloudflaredNamedTunnel({
      tunnelName: binding.tunnelName,
      hostname: binding.hostname,
      logger,
    });
  }
  return new CloudflaredQuickTunnel(logger);
}

export interface BridgeOptions {
  workspaceRoot: string;
  port?: number;
  host?: string;
  logger?: Logger;
  tunnelProvider?: TunnelProvider;
  transportMode?: TransportMode;
  openAITunnelToken?: string;
  persistRuntime?: boolean;
  authStoreFile?: string;
  pairingTtlMs?: number;
  accessTokenTtlMs?: number;
  /** Parent-created one-shot start intent for detached daemon launches. */
  pendingStartId?: string;
}

export interface Bridge {
  workspace: Workspace;
  port: number;
  host: string;
  adminToken: string;
  authStore: AuthStore;
  pairing: PairingManager;
  tunnel: TunnelProvider;
  transportMode: TransportMode;
  getPublicBaseUrl(): string | null;
  localBaseUrl(): string;
  close(): Promise<void>;
}

function listen(app: express.Express, host: string, preferredPort: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number, allowFallback: boolean): void => {
      const server = app.listen(port, host);
      server.once("listening", () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        resolve({ server, port: actual });
      });
      server.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE" && allowFallback) {
          tryListen(0, false);
        } else {
          reject(error);
        }
      });
    };
    tryListen(preferredPort, preferredPort !== 0);
  });
}

export async function startBridge(opts: BridgeOptions): Promise<Bridge> {
  const workspace = new Workspace(opts.workspaceRoot);
  const pendingStartId = opts.pendingStartId ?? process.env[PENDING_START_ENV];
  return withWorkspaceLifecycleLock(workspace.id, async () => {
    if (pendingStartId) requirePendingStart(workspace.id, pendingStartId);
    try {
      const bridge = await startBridgeUnlocked(opts, workspace);
      if (pendingStartId) completePendingStart(workspace.id, pendingStartId);
      return bridge;
    } catch (error) {
      if (pendingStartId) cancelPendingStart(workspace.id, pendingStartId);
      throw error;
    }
  });
}

async function startBridgeUnlocked(opts: BridgeOptions, workspace: Workspace): Promise<Bridge> {
  // Verify exact termination support before reading or creating any OAuth/tunnel
  // credential. A host that cannot safely stop a wedged Bridge cannot start one.
  requireProcessSafetyRuntime();

  const persistRuntimeEnabled = opts.persistRuntime !== false;
  if (persistRuntimeEnabled) await assertNoActivePersistedBridge(workspace);

  const logger = opts.logger ?? nullLogger;
  const host = opts.host ?? DEFAULT_HOST;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The bridge only binds to loopback addresses. Public exposure goes through the tunnel.");
  }

  const transportMode = opts.transportMode ?? "cloudflare";
  const openAITunnelToken =
    transportMode === "openai" ? opts.openAITunnelToken ?? ensureOpenAITunnelToken(workspace.id) : null;
  const authStore = new AuthStore(workspace.id, { file: opts.authStoreFile });
  const pairing = new PairingManager(workspace.id, { ttlMs: opts.pairingTtlMs });
  const tunnel = opts.tunnelProvider ?? tunnelForWorkspace(workspace.id, logger);
  const adminToken = `c2c_admin_${randomBytes(24).toString("base64url")}`;
  const processGeneration = requireCurrentProcessGeneration();

  let publicBaseUrl: string | null = null;

  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");

  const getBaseUrl = (req: Request): string => {
    if (publicBaseUrl) return publicBaseUrl;
    const proto = req.protocol;
    const hostHeader = req.get("host") ?? `${host}:${port}`;
    return `${proto}://${hostHeader}`;
  };

  app.get("/health", (_req, res) => {
    res.json({ service: SERVICE_NAME, version: VERSION, workspaceId: workspace.id, status: "ok" });
  });

  app.use(
    createOAuthRouter({
      store: authStore,
      pairing,
      workspaceName: workspace.name,
      getBaseUrl,
      logger,
    })
  );

  const mcpHandler = createMcpHttpHandler(() => createMcpServer({ workspace, logger }), logger);
  const mcpAuth =
    transportMode === "openai"
      ? openAITunnelAuth({ expectedToken: openAITunnelToken!, logger })
      : bearerAuth({ store: authStore, workspaceId: workspace.id, getBaseUrl, logger });
  app.all(
    "/mcp",
    express.json({ limit: "8mb" }),
    mcpAuth,
    (req: Request, res: Response) => {
      void mcpHandler(req, res);
    }
  );

  const adminGuard = (req: Request, res: Response, next: NextFunction): void => {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    const viaProxy = Boolean(
      req.headers["cf-connecting-ip"] ||
      req.headers["forwarded"] ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"]
    );
    const header = req.headers.authorization ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!isLoopback || viaProxy || token !== adminToken) {
      res.status(404).end();
      return;
    }
    next();
  };

  app.post("/admin/pairing", adminGuard, (_req, res) => {
    const session = pairing.create();
    logger.info("Created pairing session");
    res.json({ code: session.code, expiresAt: session.expiresAt });
  });

  app.get("/admin/info", adminGuard, (_req, res) => {
    res.json({
      service: SERVICE_NAME,
      version: VERSION,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspaceRoot: workspace.root,
      port,
      transportMode,
      publicUrl: publicBaseUrl,
      tunnel: tunnel.status(),
      tokenCount: authStore.tokenCount(),
      pairingActive: pairing.hasActiveSession(),
      pid: process.pid,
      processGeneration,
      startedAt,
    });
  });

  app.post("/admin/tunnel/start", adminGuard, (_req, res) => {
    if (transportMode !== "cloudflare") {
      res.status(409).json({
        error: "transport_mode_mismatch",
        message: "Public Cloudflare tunnels are disabled while OpenAI Secure MCP Tunnel mode is selected.",
      });
      return;
    }
    tunnel
      .start(port)
      .then((url) => {
        publicBaseUrl = url;
        persistRuntime();
        res.json({ url });
      })
      .catch((error: Error) => {
        logger.error(`Tunnel start failed: ${error.message}`);
        res.status(500).json({ error: "tunnel_failed", message: error.message });
      });
  });

  app.post("/admin/tunnel/stop", adminGuard, (_req, res) => {
    void tunnel.stop().then(() => {
      publicBaseUrl = null;
      persistRuntime();
      res.json({ stopped: true });
    });
  });

  app.post("/admin/revoke-all", adminGuard, (_req, res) => {
    const count = authStore.revokeAll();
    pairing.invalidateAll();
    logger.info("Revoked all tokens", { count });
    res.json({ revoked: count });
  });

  app.post("/admin/shutdown", adminGuard, (_req, res) => {
    res.json({ shuttingDown: true });
    setTimeout(() => {
      void shutdown().then(() => process.exit(0));
    }, 100);
  });

  const { server, port } = await listen(app, host, opts.port ?? DEFAULT_PORT);
  const startedAt = new Date().toISOString();
  logger.info(`Bridge listening on ${host}:${port} for workspace ${workspace.name} (${workspace.id})`);

  const runtimeState = (): RuntimeState => ({
    service: SERVICE_NAME,
    version: VERSION,
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: process.pid,
    processGeneration,
    port,
    adminToken,
    publicUrl: publicBaseUrl,
    startedAt,
  });

  const persistRuntime = (): void => {
    if (!persistRuntimeEnabled) return;
    writeRuntimeState(runtimeState());
  };

  try {
    persistRuntime();
  } catch (error) {
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (persistRuntimeEnabled) removeRuntimeStateGeneration(runtimeState());
    throw error;
  }

  if (persistRuntimeEnabled) activePersistedBridges.add(workspace.id);

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (persistRuntimeEnabled) activePersistedBridges.delete(workspace.id);
    await tunnel.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (persistRuntimeEnabled) removeRuntimeStateGeneration(runtimeState());
    logger.info("Bridge stopped");
  };

  return {
    workspace,
    port,
    host,
    adminToken,
    authStore,
    pairing,
    tunnel,
    transportMode,
    getPublicBaseUrl: () => publicBaseUrl,
    localBaseUrl: () => `http://${host}:${port}`,
    close: shutdown,
  };
}
