import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startBridge } from "../bridge/server.js";
import { startWorkspaceRouter } from "../router/server.js";
import {
  createWorkspaceRouter,
  issueRouteCapability,
  readWorkspaceRouter,
} from "../router/state.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, ensureBridge, stopBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import { gitInfo } from "../workspace/git.js";
import { revokeLegacyWindowsWorkspaceAccess, revokeWorkspaceAccess } from "../auth/revoke.js";
import { appendExecutionRecord } from "../execution/records.js";
import { detectTunnelBinaries } from "../tunnel/detect.js";
import {
  chooseQuickTunnel,
  hasCloudflaredCert,
  ProcessCloudflaredAccount,
  provisionNamedTunnel,
} from "../tunnel/named-provision.js";
import { parseZoneInput, suggestedNamedHostname } from "../tunnel/hostname.js";
import {
  isNamedTunnelReady,
  NAMED_LOGIN_PROMPT,
  NAMED_REPAIR_MESSAGE,
  needsTunnelChoice,
  readTunnelState,
  TUNNEL_CHOICE_PROMPT,
} from "../tunnel/state.js";
import {
  openAITunnelTokenFile,
  readTransportMode,
  type TransportMode,
} from "../tunnel/transport-mode.js";
import {
  defaultRuntimeProfileFile,
  diagnoseRuntimeHeader,
  probeManagedRuntime,
  repairRuntimeProfileHeader,
  repairWindowsUserRuntimeHeader,
} from "../tunnel/runtime-config.js";
import {
  ensureWorkspaceOpenAITunnelToken,
  switchWorkspaceTransport,
} from "../tunnel/switch-transport.js";
import { Logger } from "../logger/index.js";
import { getStateDir } from "../config/paths.js";
import { ensureSandboxAllowlist, getCodexConfigPath, isStateDirAllowlisted } from "../config/sandbox-allow.js";
import {
  CHATGPT_CREATE_CONNECTOR_URL,
  CHATGPT_DEVELOPER_MODE_URL,
  CHATGPT_PLUGINS_URL,
  connectorAction,
  connectorNameFor,
  mcpUrlFromPublic,
  normalizePublicUrl,
  readLastEndpoint,
  reclaimUserMessage,
  writeLastEndpoint,
  type LastEndpoint,
} from "../config/endpoint.js";
import { PRODUCT_NAME, VERSION } from "../version.js";
import {
  assertReceiptIdentity,
  beginTaskSend,
  clearTaskSession,
  confirmTaskSendAccepted,
  confirmTaskDelivery,
  confirmTaskReply,
  confirmTaskWorkspace,
  deliveryReadbackPhase,
  attachTaskRouteCapability,
  claimStandbyConversation,
  failTaskDelivery,
  importStandbyConversation,
  markTaskUnavailable,
  migrateSessionLedger,
  newMessageId,
  readSessionRegistry,
  readTaskSession,
  recordTaskDeliveryPending,
  recordTaskReadResult,
  recordTaskHostControl,
  type HostControlObservation,
  restoreTaskConversation,
  quarantineStandbyConversation,
  readStandbyPool,
  resolveCodexTaskId,
} from "../session/state.js";

const program = new Command();

const say = (msg: string): void => {
  process.stdout.write(msg + "\n");
};

function routerAnchorForWorkspace(root: string): Workspace {
  const workspace = new Workspace(root);
  const router = readWorkspaceRouter();
  const registered = router?.workspaces.some((entry) => entry.workspaceId === workspace.id);
  return router && registered ? new Workspace(router.anchor.root) : workspace;
}

function runtimeStatusSummary(runtimeAlias: string): Record<string, unknown> {
  return { ...probeManagedRuntime({ runtimeAlias }) };
}
const check = (msg: string): void => say(`✓ ${msg}`);
const cross = (msg: string): void => say(`✗ ${msg}`);

function resolveWorkspace(option?: string): string {
  return path.resolve(option ?? process.cwd());
}

function persistWorkspaceEndpoint(opts: {
  workspaceId: string;
  workspaceName: string;
  port: number;
  publicUrl: string | null;
  mcpUrl: string;
  previous?: LastEndpoint | null;
}): string {
  const previous = opts.previous ?? readLastEndpoint(opts.workspaceId);
  const connectorName = connectorNameFor({
    workspaceName: opts.workspaceName,
    workspaceId: opts.workspaceId,
    previousName: previous?.connectorName,
    hadEndpointBefore: Boolean(previous),
  });
  writeLastEndpoint({
    workspaceId: opts.workspaceId,
    port: opts.port,
    publicUrl: opts.publicUrl,
    mcpUrl: opts.mcpUrl,
    connectorName,
  });
  return connectorName;
}

function tunnelChoicePayload(workspace: Workspace, zoneHint?: string): Record<string, unknown> {
  const state = readTunnelState(workspace.id);
  const zone = parseZoneInput(zoneHint ?? "") ?? state.zone ?? null;
  return {
    ok: true,
    needsChoice: needsTunnelChoice(state),
    preference: state.preference,
    loggedIn: hasCloudflaredCert(),
    namedReady: isNamedTunnelReady(state),
    zone,
    hostname: state.hostname ?? null,
    suggestedHostname: zone ? suggestedNamedHostname(zone, workspace.name, workspace.id) : null,
    userPrompt: needsTunnelChoice(state) ? TUNNEL_CHOICE_PROMPT : undefined,
    loginPrompt: NAMED_LOGIN_PROMPT,
    fallbackReason: state.fallbackReason,
  };
}

function trySandboxAllow():
  | { ok: true; added: boolean; alreadyAllowed: boolean; stateDir: string; configPath: string }
  | { ok: false; added: false; alreadyAllowed: false; error: string } {
  try {
    const result = ensureSandboxAllowlist();
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, added: false, alreadyAllowed: false, error: (error as Error).message };
  }
}

interface TunnelStartResponse {
  url?: string;
  error?: string;
  message?: string;
}

interface PairingResponse {
  code: string;
  expiresAt: number;
}

interface AdminInfo {
  workspaceId: string;
  workspaceName: string;
  workspaceRoot: string;
  port: number;
  transportMode: TransportMode;
  publicUrl: string | null;
  tunnel: { running: boolean; url: string | null; provider: string };
  tokenCount: number;
  pairingActive: boolean;
  pid: number;
  startedAt: string;
}

interface EnsuredRouter {
  anchor: Workspace;
  workspace: Workspace;
  created: boolean;
}

/**
 * Register the caller's workspace under the one global Router. The anchor is
 * the only Bridge runtime and therefore retains the existing OpenAI Tunnel
 * alias, credential and ChatGPT connector.
 */
async function ensureWorkspaceRouter(workspaceRoot: string, migrate = false): Promise<EnsuredRouter> {
  const workspace = new Workspace(workspaceRoot);
  let state = readWorkspaceRouter();
  let created = false;
  if (!state) {
    await createWorkspaceRouter(workspace.root);
    state = readWorkspaceRouter();
    created = true;
  }
  if (!state) throw new Error("global workspace router was not initialized");
  const router = await createWorkspaceRouter(state.anchor.root);
  await router.register(workspace.root);
  const anchor = new Workspace(state.anchor.root);
  if (created || migrate) {
    // Restart only the anchor. Its state files and OpenAI Tunnel token remain
    // in place, while serve now instantiates the Router MCP server.
    const live = await findLiveBridge(anchor.id);
    if (live) await stopBridge(anchor.root);
  }
  return { anchor, workspace, created };
}

async function ensureBridgeAndTunnel(
  workspaceRoot: string,
  opts: { tunnel: boolean }
): Promise<{ runtime: RuntimeState; info: AdminInfo; mcpUrl: string | null }> {
  const workspace = new Workspace(workspaceRoot);
  const desiredMode = readTransportMode(workspace.id);
  let { runtime } = await ensureBridge(workspaceRoot);
  let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");

  // Transport mode is a process-level security boundary. Restart a stale bridge
  // rather than mutating authentication policy inside a live process.
  if (info.transportMode !== desiredMode) {
    await stopBridge(workspaceRoot);
    await new Promise((resolve) => setTimeout(resolve, 300));
    runtime = (await ensureBridge(workspaceRoot)).runtime;
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
  }

  let mcpUrl: string | null = info.publicUrl ? `${info.publicUrl}/mcp` : null;
  if (opts.tunnel && desiredMode === "cloudflare" && !info.publicUrl) {
    const binaries = detectTunnelBinaries();
    if (!binaries.cloudflared) {
      throw new Error(
        "NEED_CLOUDFLARED: cloudflared is not installed. Install it first (macOS: brew install cloudflared)."
      );
    }
    const result = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
    if (!result.url) throw new Error(result.message ?? "Tunnel start failed");
    info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    mcpUrl = `${result.url}/mcp`;
  }
  return { runtime, info, mcpUrl };
}

program
  .name("c2c")
  .description(`${PRODUCT_NAME} — ChatGPT thinks. Codex works.`)
  .version(VERSION, "-v, --version")
  .configureHelp({ sortSubcommands: true });

// ---------------------------------------------------------------- serve (internal)

program
  .command("serve", { hidden: true })
  .description("Run the bridge in the foreground (internal)")
  .requiredOption("--workspace <path>")
  .option("--port <port>", "preferred port")
  .action(async (opts: { workspace: string; port?: string }) => {
    const logger = new Logger({ name: "bridge", console: true });
    const workspaceRoot = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(workspaceRoot);
    const router = readWorkspaceRouter();
    const isRouterAnchor = router && path.resolve(router.anchor.root) === workspace.root;
    const bridge = isRouterAnchor
      ? await startWorkspaceRouter({
          anchorRoot: workspaceRoot,
          port: opts.port ? parseInt(opts.port, 10) : undefined,
          logger,
          transportMode: readTransportMode(workspace.id),
        })
      : await startBridge({
          workspaceRoot,
          port: opts.port ? parseInt(opts.port, 10) : undefined,
          logger,
          transportMode: readTransportMode(workspace.id),
        });
    const shutdown = (): void => {
      void bridge.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    say(`${isRouterAnchor ? "router" : "bridge"} ready on ${bridge.localBaseUrl()} (workspace ${bridge.workspace.name})`);
  });

// ---------------------------------------------------------------- start

program
  .command("start")
  .description("Start (or reuse) the bridge for this workspace")
  .option("-w, --workspace <path>", "workspace root (defaults to current directory)")
  .option("--tunnel", "also establish the secure public connection", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const routed = await ensureWorkspaceRouter(root);
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(routed.anchor.root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : readLastEndpoint(info.workspaceId)?.connectorName ?? "C2C Router";
      if (opts.json) {
        say(JSON.stringify({
          ok: true, port: runtime.port, workspaceId: routed.workspace.id, workspaceName: routed.workspace.name,
          anchorWorkspaceId: info.workspaceId, mcpUrl, connectorName, router: true,
        }));
        return;
      }
      check(`当前项目已注册（${routed.workspace.name}）`);
      check("全局 Router 已启动");
      if (mcpUrl) check("安全连接已建立");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- setup

program
  .command("setup")
  .description("First-time setup: bridge + secure connection + pairing code")
  .option("-w, --workspace <path>")
  .option("--no-tunnel", "local-only setup (development)")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; tunnel: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (!opts.json) {
        say(PRODUCT_NAME);
        say("");
        say("正在连接 ChatGPT…");
        say("");
      }
      const sandbox = trySandboxAllow();
      const routed = await ensureWorkspaceRouter(root);
      const { runtime, info, mcpUrl } = await ensureBridgeAndTunnel(routed.anchor.root, { tunnel: opts.tunnel });
      const connectorName = mcpUrl
        ? persistWorkspaceEndpoint({
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            port: runtime.port,
            publicUrl: info.publicUrl,
            mcpUrl,
          })
        : connectorNameFor({
            workspaceName: info.workspaceName,
            workspaceId: info.workspaceId,
            previousName: readLastEndpoint(info.workspaceId)?.connectorName,
            hadEndpointBefore: Boolean(readLastEndpoint(info.workspaceId)),
          });
      const pairingResult = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      const tunnelState = readTunnelState(info.workspaceId);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: info.workspaceId,
            workspaceName: info.workspaceName,
            connectorName,
            mcpUrl: mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`,
            local: mcpUrl === null,
            transportMode: info.transportMode,
            localMcpUrl: `http://127.0.0.1:${runtime.port}/mcp`,
            openai:
              info.transportMode === "openai"
                ? {
                    headerName: "X-C2C-Tunnel-Token",
                    tokenFile: openAITunnelTokenFile(info.workspaceId),
                    runtimeAlias: `c2c-${info.workspaceId}`,
                    credentialSource: "managed_dpapi",
                  }
                : null,
            pairingCode: info.transportMode === "cloudflare" ? pairingResult.code : null,
            pairingExpiresAt: info.transportMode === "cloudflare" ? pairingResult.expiresAt : null,
            sandbox,
            tunnel: {
              mode: isNamedTunnelReady(tunnelState) ? "named" : "quick",
              hostname: tunnelState.hostname ?? null,
              fallback: Boolean(tunnelState.fallbackReason),
            },
          })
        );
        return;
      }
      check(`当前项目已注册（${routed.workspace.name}）`);
      check("全局 Router 已启动");
      say("");
      if (info.transportMode === "openai") {
        await ensureWorkspaceOpenAITunnelToken(routed.anchor.root);
        check("默认安全模式：OpenAI Secure MCP Tunnel");
        say(`本机 MCP：http://127.0.0.1:${runtime.port}/mcp`);
        say(`本机认证文件：${openAITunnelTokenFile(info.workspaceId)}`);
        say(`运行别名：c2c-${info.workspaceId}`);
        say("");
        say("下一步：使用已配置的托管 Tunnel；ChatGPT 连接器选择 Connection: Tunnel。");
        say("Runtime 凭据只从本机托管 DPAPI 文件读取；用 `c2c runtime diagnose` 检查状态。");
      } else {
        if (mcpUrl) check("Cloudflare fallback 已建立");
        say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
        say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
        say("");
        say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      }
      say("如果你在使用 Codex Skill，这一步会自动完成。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- transport

program
  .command("transport")
  .description("Show or select the MCP transport (OpenAI Secure Tunnel by default)")
  .option("-w, --workspace <path>")
  .option("--mode <mode>", "openai or cloudflare")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; mode?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      if (opts.mode) {
        const requested = opts.mode.trim().toLowerCase();
        if (requested !== "openai" && requested !== "cloudflare") {
          throw new Error("mode must be openai or cloudflare");
        }
        const next = requested as TransportMode;
        await switchWorkspaceTransport(root, next);
      }

      const mode = readTransportMode(workspace.id);
      if (mode === "openai" && !opts.mode) await ensureWorkspaceOpenAITunnelToken(root);
      const payload = {
        ok: true,
        mode,
        defaultMode: "openai",
        workspaceId: workspace.id,
        openai:
          mode === "openai"
            ? {
                headerName: "X-C2C-Tunnel-Token",
                tokenFile: openAITunnelTokenFile(workspace.id),
                runtimeAlias: `c2c-${workspace.id}`,
                credentialSource: "managed_dpapi",
              }
            : null,
      };
      if (opts.json) say(JSON.stringify(payload));
      else if (mode === "openai") {
        check("传输模式：OpenAI Secure MCP Tunnel（默认）");
        say("公网 MCP 入口：关闭");
      } else {
        check("传输模式：Cloudflare fallback（显式启用）");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- stop / restart

program
  .command("stop")
  .description("Stop the bridge for this workspace")
  .option("-w, --workspace <path>")
  .action(async (opts: { workspace?: string }) => {
    const stopped = await stopBridge(resolveWorkspace(opts.workspace));
    if (stopped) check("Bridge 已停止");
    else say("没有正在运行的 Bridge。");
  });

program
  .command("restart")
  .description("Restart the bridge for this workspace")
  .option("-w, --workspace <path>")
  .option("--tunnel", "re-establish the secure public connection", false)
  .action(async (opts: { workspace?: string; tunnel: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const routed = await ensureWorkspaceRouter(root, true);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { info, mcpUrl } = await ensureBridgeAndTunnel(routed.anchor.root, { tunnel: opts.tunnel });
      check(`全局 Router 已重启（${routed.workspace.name}）`);
      if (mcpUrl) check(`安全连接已建立`);
    } catch (error) {
      handleCliError(error, false);
    }
  });

// ---------------------------------------------------------------- status

program
  .command("status")
  .description("Show bridge status for this workspace")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const router = readWorkspaceRouter();
    const registered = router?.workspaces.some((entry) => entry.workspaceId === workspace.id && !entry.revokedAt);
    const anchor = router && registered ? new Workspace(router.anchor.root) : workspace;
    const runtime = await findLiveBridge(anchor.id);
    if (!runtime) {
      if (opts.json) say(JSON.stringify({ ok: false, running: false, workspaceId: workspace.id, anchorWorkspaceId: anchor.id }));
      else say("Bridge 未运行。使用 `c2c start` 启动。");
      return;
    }
    const info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
    if (opts.json) {
      say(JSON.stringify({
        ok: true,
        running: true,
        ...info,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        anchorWorkspaceId: anchor.id,
        router: Boolean(router && registered),
      }));
      return;
    }
    say(PRODUCT_NAME);
    say("");
    check(`Workspace：${workspace.name}`);
    check(`${router && registered ? "Router" : "Bridge"}：运行中（端口 ${info.port}）`);
    check(`传输模式：${info.transportMode === "openai" ? "OpenAI Secure MCP Tunnel" : "Cloudflare fallback"}`);
    if (info.transportMode === "openai") {
      say("· 公网 MCP 入口：关闭");
      say("· 本机 MCP：仅 loopback + 每工作区随机令牌可访问");
    } else if (info.tunnel.running && info.tunnel.url) {
      check(`Cloudflare fallback：${info.tunnel.url}/mcp`);
      say(`· OAuth 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
    } else {
      say("· Cloudflare fallback：未启动");
    }
  });

// ---------------------------------------------------------------- global Router

const routerCommand = program
  .command("router")
  .description("Manage the global multi-workspace C2C Router");

routerCommand
  .command("migrate")
  .description("Migrate the current Bridge into the global Router anchor")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const routed = await ensureWorkspaceRouter(resolveWorkspace(opts.workspace), true);
      const { runtime, info } = await ensureBridgeAndTunnel(routed.anchor.root, { tunnel: false });
      const payload = {
        ok: true,
        router: true,
        workspaceId: routed.workspace.id,
        anchorWorkspaceId: routed.anchor.id,
        port: runtime.port,
        transportMode: info.transportMode,
      };
      if (opts.json) say(JSON.stringify(payload));
      else check(`全局 Router 已迁移；网关锚点：${routed.anchor.name}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

routerCommand
  .command("ensure", { isDefault: true })
  .description("Register this workspace and ensure the anchor Router is running")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const routed = await ensureWorkspaceRouter(resolveWorkspace(opts.workspace));
      const { runtime, info } = await ensureBridgeAndTunnel(routed.anchor.root, { tunnel: false });
      const payload = {
        ok: true,
        router: true,
        workspaceId: routed.workspace.id,
        workspaceName: routed.workspace.name,
        anchorWorkspaceId: routed.anchor.id,
        port: runtime.port,
        transportMode: info.transportMode,
      };
      if (opts.json) say(JSON.stringify(payload));
      else check(`工作区已注册到全局 Router：${routed.workspace.name}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

routerCommand
  .command("register")
  .description("Register a workspace without starting or changing the gateway")
  .requiredOption("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace: string; json: boolean }) => {
    try {
      const routed = await ensureWorkspaceRouter(resolveWorkspace(opts.workspace));
      const payload = {
        ok: true,
        workspaceId: routed.workspace.id,
        workspaceName: routed.workspace.name,
        anchorWorkspaceId: routed.anchor.id,
      };
      if (opts.json) say(JSON.stringify(payload));
      else check(`工作区已注册：${routed.workspace.name}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

routerCommand
  .command("status")
  .description("Show the Router anchor, registered workspaces and capability count")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const state = readWorkspaceRouter();
    const payload = state
      ? {
          ok: true,
          router: true,
          anchor: state.anchor,
          workspaces: state.workspaces,
          capabilityCount: state.capabilities.filter((entry) => !entry.revokedAt).length,
        }
      : { ok: false, router: false, error: "global workspace router is not initialized" };
    if (opts.json) say(JSON.stringify(payload));
    else if (state) check(`Router 锚点：${state.anchor.name}；已注册 ${state.workspaces.filter((entry) => !entry.revokedAt).length} 个工作区`);
    else say("全局 Router 尚未初始化。");
  });

// ---------------------------------------------------------------- doctor

program
  .command("doctor")
  .description("Diagnose and auto-repair the connection")
  .option("-w, --workspace <path>")
  .option("--no-fix", "diagnose only, do not repair")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; fix: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const report: Record<string, { ok: boolean; detail?: string }> = {};
    const results: string[] = [];

    // Node
    const nodeMajor = parseInt(process.versions.node.split(".")[0], 10);
    report.node = { ok: nodeMajor >= 20, detail: `v${process.versions.node}` };

    // Codex sandbox writable_roots (so later chats do not need elevation)
    if (opts.fix) {
      const sandbox = trySandboxAllow();
      if (sandbox.ok) {
        report.sandbox = { ok: true, detail: sandbox.alreadyAllowed ? "已在白名单" : "已写入白名单" };
        if (sandbox.added) results.push("已将本地设置目录加入 Codex 沙箱白名单");
      } else {
        report.sandbox = { ok: false, detail: sandbox.error };
      }
    } else {
      try {
        const configPath = getCodexConfigPath();
        const allowed =
          fs.existsSync(configPath) && isStateDirAllowlisted(fs.readFileSync(configPath, "utf8"), getStateDir());
        report.sandbox = allowed ? { ok: true, detail: "已在白名单" } : { ok: false, detail: "未在白名单" };
      } catch (error) {
        report.sandbox = { ok: false, detail: (error as Error).message };
      }
    }

    // Workspace
    let workspace: Workspace | null = null;
    try {
      workspace = new Workspace(root);
      report.workspace = { ok: true, detail: workspace.name };
    } catch (error) {
      report.workspace = { ok: false, detail: (error as Error).message };
    }

    // Bridge
    let runtime: RuntimeState | null = null;
    if (workspace) {
      runtime = await findLiveBridge(workspace.id);
      if (!runtime && opts.fix) {
        try {
          runtime = (await ensureBridge(root)).runtime;
          results.push("已自动启动 Bridge");
        } catch (error) {
          report.bridge = { ok: false, detail: (error as Error).message };
        }
      }
      if (runtime) report.bridge = { ok: true, detail: `端口 ${runtime.port}` };
      else report.bridge = report.bridge ?? { ok: false, detail: "未运行" };
    }

    // MCP local reachability (401 without token means MCP + auth both work)
    if (runtime) {
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
        });
        report.mcp = { ok: response.status === 401, detail: `未授权请求返回 ${response.status}` };
        report.oauth = { ok: response.status === 401 };
      } catch (error) {
        report.mcp = { ok: false, detail: (error as Error).message };
      }
    }

    // Tunnel + remote reachability. If this workspace once had a public URL,
    // a full quit reclaims it — restore a tunnel and tell the Skill to update
    // the existing ChatGPT connector (never treat that as "local mode").
    const lastEndpoint = workspace ? readLastEndpoint(workspace.id) : null;
    const connectorName = workspace
      ? connectorNameFor({
          workspaceName: workspace.name,
          workspaceId: workspace.id,
          previousName: lastEndpoint?.connectorName,
          hadEndpointBefore: Boolean(lastEndpoint),
        })
      : "Codex with ChatGPT";
    const selectedTransport = workspace ? readTransportMode(workspace.id) : "openai";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = selectedTransport === "cloudflare" && tunnelState ? isNamedTunnelReady(tunnelState) : false;
    let namedRepair: { needed: boolean; userMessage?: string } = { needed: false };
    let chatgptRepair: {
      needed: boolean;
      reason?: string;
      connectorAction: "none" | "create" | "update";
      connectorName: string;
      userMessage?: string;
      mcpUrl: string | null;
      previousMcpUrl: string | null;
      pairingCode?: string;
      pairingExpiresAt?: number;
      pages: {
        developerMode: string;
        plugins: string;
        createConnector: string;
      };
    } = {
      needed: false,
      connectorAction: "none",
      connectorName,
      mcpUrl: lastEndpoint?.mcpUrl ?? null,
      previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
      pages: {
        developerMode: CHATGPT_DEVELOPER_MODE_URL,
        plugins: CHATGPT_PLUGINS_URL,
        createConnector: CHATGPT_CREATE_CONNECTOR_URL,
      },
    };

    if (runtime) {
      let info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
      if (namedReady && opts.fix && info.tunnel.provider !== "cloudflare-named") {
        await stopBridge(root);
        await new Promise((resolve) => setTimeout(resolve, 400));
        try {
          runtime = (await ensureBridge(root)).runtime;
          info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
          results.push("已切换到固定域名连接");
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }
      const expectedPublic = info.transportMode === "cloudflare" && (Boolean(lastEndpoint?.publicUrl) || namedReady);
      let currentUrl = info.publicUrl ?? info.tunnel.url;
      let healthy = false;
      if (currentUrl) {
        try {
          const response = await fetch(`${currentUrl}/health`, { signal: AbortSignal.timeout(8000) });
          healthy = response.ok;
        } catch {
          healthy = false;
        }
      }

      if ((!currentUrl || !healthy) && opts.fix && (expectedPublic || info.tunnel.running)) {
        try {
          const binaries = detectTunnelBinaries();
          if (!binaries.cloudflared) {
            report.tunnel = { ok: false, detail: "NEED_CLOUDFLARED" };
          } else {
            const started = await adminFetch<TunnelStartResponse>(runtime, "POST", "/admin/tunnel/start", 90_000);
            if (started.url) {
              const previousUrl = lastEndpoint?.publicUrl;
              currentUrl = started.url;
              healthy = true;
              info = await adminFetch<AdminInfo>(runtime, "GET", "/admin/info");
              const sameAddress =
                previousUrl && normalizePublicUrl(previousUrl) === normalizePublicUrl(started.url);
              results.push(sameAddress ? "已重新建立安全连接" : "已重新建立安全连接（地址已更换）");
            }
          }
        } catch (error) {
          report.tunnel = { ok: false, detail: (error as Error).message };
        }
      }

      if (currentUrl && healthy) {
        report.tunnel = { ok: true, detail: currentUrl };
        const nextMcp = mcpUrlFromPublic(currentUrl);
        const action = connectorAction(lastEndpoint?.mcpUrl, nextMcp);
        const boundName = nextMcp
          ? persistWorkspaceEndpoint({
              workspaceId: info.workspaceId,
              workspaceName: info.workspaceName,
              port: runtime.port,
              publicUrl: currentUrl,
              mcpUrl: nextMcp,
              previous: lastEndpoint,
            })
          : connectorName;
        chatgptRepair = {
          ...chatgptRepair,
          needed: action === "update",
          reason: action === "update" ? "address_reclaimed" : undefined,
          connectorAction: action,
          connectorName: boundName,
          userMessage: action === "update" ? reclaimUserMessage(boundName) : undefined,
          mcpUrl: nextMcp,
          previousMcpUrl: lastEndpoint?.mcpUrl ?? null,
        };
        if (action === "update") {
          try {
            const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
            chatgptRepair.pairingCode = pairing.code;
            chatgptRepair.pairingExpiresAt = pairing.expiresAt;
            results.push(`已生成新的配对码，需要更新「${boundName}」`);
          } catch (error) {
            report.oauth = { ok: false, detail: (error as Error).message };
          }
        }
      } else if (namedReady) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "NAMED_TUNNEL_DOWN" };
        namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
      } else if (expectedPublic) {
        report.tunnel = report.tunnel ?? { ok: false, detail: "安全连接未恢复" };
        chatgptRepair = {
          ...chatgptRepair,
          needed: true,
          reason: "address_reclaimed",
          connectorAction: "update",
          connectorName,
          userMessage: reclaimUserMessage(connectorName),
          mcpUrl: null,
        };
      } else if (!currentUrl) {
        report.tunnel = { ok: true, detail: "未启用（本地模式）" };
      } else {
        report.tunnel = { ok: false, detail: "公网地址无法访问" };
      }
    } else if (namedReady) {
      report.tunnel = { ok: false, detail: "NAMED_TUNNEL_DOWN" };
      namedRepair = { needed: true, userMessage: NAMED_REPAIR_MESSAGE };
    } else if (selectedTransport === "cloudflare" && lastEndpoint?.publicUrl) {
      report.tunnel = { ok: false, detail: "安全连接未运行" };
      chatgptRepair = {
        ...chatgptRepair,
        needed: true,
        reason: "address_reclaimed",
        connectorAction: "update",
        connectorName,
        userMessage: reclaimUserMessage(connectorName),
      };
    }

    if (opts.json) {
      say(JSON.stringify({ report, repairs: results, chatgptRepair, namedRepair }));
      return;
    }
    say(`${PRODUCT_NAME} Doctor`);
    say("");
    const labels: Record<string, string> = {
      node: "Node.js",
      sandbox: "Sandbox",
      workspace: "Workspace",
      bridge: "Bridge",
      mcp: "MCP",
      oauth: "OAuth",
      tunnel: "Tunnel",
    };
    let allOk = true;
    for (const [key, value] of Object.entries(report)) {
      const label = labels[key] ?? key;
      if (value.ok) check(`${label}${value.detail ? `（${value.detail}）` : ""}`);
      else {
        cross(`${label}${value.detail ? `：${value.detail}` : ""}`);
        allOk = false;
      }
    }
    for (const repair of results) say(`· ${repair}`);
    say("");
    if (namedRepair.needed && namedRepair.userMessage) {
      say(namedRepair.userMessage);
      say("");
    }
    if (chatgptRepair.needed && chatgptRepair.userMessage) {
      say(chatgptRepair.userMessage);
      if (chatgptRepair.mcpUrl) say(`新的连接地址：${chatgptRepair.mcpUrl}`);
      if (chatgptRepair.pairingCode) say(`配对码：${chatgptRepair.pairingCode}`);
      say("");
    }
    say(
      allOk && !chatgptRepair.needed && !namedRepair.needed
        ? "Everything looks good."
        : chatgptRepair.needed
          ? "本地已就绪，还需要在 ChatGPT 删除并重新添加该连接。"
          : namedRepair.needed
            ? "固定域名还没连上，需要先登录 Cloudflare。"
            : "仍有问题未解决，可尝试 `c2c restart --tunnel`。"
    );
    if (!allOk || namedRepair.needed) process.exitCode = 1;
  });

// ---------------------------------------------------------------- pair / unpair

program
  .command("pair")
  .description("Generate a fresh pairing code")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    try {
      const { runtime } = await ensureBridge(resolveWorkspace(opts.workspace));
      const pairing = await adminFetch<PairingResponse>(runtime, "POST", "/admin/pairing");
      if (opts.json) say(JSON.stringify({ ok: true, pairingCode: pairing.code, expiresAt: pairing.expiresAt }));
      else {
        say(`配对码：${pairing.code}`);
        say(`（${Math.round((pairing.expiresAt - Date.now()) / 60000)} 分钟内有效，仅可使用一次）`);
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("unpair")
  .description("Revoke ChatGPT's access to this workspace immediately")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const result = await revokeWorkspaceAccess(root);
      if (opts.json) {
        say(JSON.stringify({ ok: true, ...result }));
      } else if (result.transportMode === "openai") {
        check("已断开 ChatGPT 对当前项目的访问（Tunnel 凭证已撤销，Bridge 已停止）");
      } else {
        check("已断开 ChatGPT 对当前项目的访问（OAuth 令牌已吊销）");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

program
  .command("legacy-cleanup")
  .description("Quiesce and clear this workspace from the pre-migration Windows state view")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      if (process.platform !== "win32") {
        throw new Error("legacy-cleanup applies only to the pre-migration Windows state directory");
      }
      const result = await revokeLegacyWindowsWorkspaceAccess(root);
      if (opts.json) {
        say(
          JSON.stringify({
            ok: true,
            workspaceId: result.workspaceId,
            cleanedCurrentProcessView: true,
            removedArtifacts: result.removedArtifacts,
            alreadyClean: result.alreadyClean,
            ...(result.revocation ?? {}),
          })
        );
      } else {
        if (result.alreadyClean) check("当前进程可见的旧 Windows 状态已经干净");
        else check("当前进程可见的旧 Windows 状态已停机并清理");
        say("若这是普通 Windows Terminal，请在 packaged Codex 或 ChatGPT 内再执行同一命令；反向亦然。");
      }
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

// ---------------------------------------------------------------- logs / workspace / record

program
  .command("logs")
  .description("Show recent bridge logs")
  .option("-w, --workspace <path>")
  .option("-n, --lines <n>", "number of lines", "50")
  .option("--verbose", "include debug detail", false)
  .action((opts: { workspace?: string; lines: string; verbose: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const candidates = [
      path.join(getStateDir(), "logs", "bridge.log"),
      path.join(getStateDir(), "logs", `bridge-${workspace.id}.out.log`),
    ];
    let shown = false;
    for (const file of candidates) {
      if (!fs.existsSync(file)) continue;
      const lines = fs.readFileSync(file, "utf8").trim().split("\n");
      const filtered = opts.verbose ? lines : lines.filter((line) => !line.includes(" DEBUG "));
      say(filtered.slice(-parseInt(opts.lines, 10)).join("\n"));
      shown = true;
    }
    if (!shown) say("暂无日志。");
  });

program
  .command("workspace")
  .description("Show workspace identity and project info")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const project = workspace.detectProject();
    const data = { workspaceId: workspace.id, name: workspace.name, root: workspace.root, ...project };
    if (opts.json) say(JSON.stringify(data));
    else {
      say(`Workspace：${data.name}（${data.workspaceId}）`);
      say(`类型：${data.projectType}  语言：${data.languages.join(", ") || "-"}`);
      say(`路径：${data.root}`);
    }
  });

// ---------------------------------------------------------------- sandbox-allow (Codex writable_roots, macOS + Windows)

program
  .command("sandbox-allow")
  .description("Add the local settings directory to the Codex sandbox allowlist")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const result = trySandboxAllow();
    if (opts.json) {
      say(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (!result.ok) {
      cross(`无法写入 Codex 沙箱白名单：${result.error}`);
      process.exitCode = 1;
      return;
    }
    if (result.alreadyAllowed) check("沙箱白名单已就绪，后续对话无需再提权");
    else check("已将本地设置目录加入 Codex 沙箱白名单（后续对话无需再提权）");
  });

// ---------------------------------------------------------------- update-check (once per local day)

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runGit(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 8000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true,
  });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
}

program
  .command("update-check")
  .description("Check GitHub for a newer version (real check at most once per local day)")
  .option("--force", "check even if already checked today", false)
  .option("--json", "machine-readable output", false)
  .action((opts: { force: boolean; json: boolean }) => {
    const file = path.join(getStateDir(), "update-check.json");
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in local tz
    let last: { date?: string; updateAvailable?: boolean } = {};
    try {
      last = JSON.parse(fs.readFileSync(file, "utf8")) as typeof last;
    } catch {
      /* first run */
    }

    const emit = (data: {
      checked: boolean;
      updateAvailable: boolean;
      localCommit?: string;
      remoteCommit?: string;
      note?: string;
    }): void => {
      if (opts.json) say(JSON.stringify({ ok: true, version: VERSION, ...data }));
      else if (data.updateAvailable) say(`发现新版本（本地 ${data.localCommit?.slice(0, 7)} → 远端 ${data.remoteCommit?.slice(0, 7)}）。`);
      else say(data.note ?? "已是最新版本。");
    };

    if (!opts.force && last.date === today) {
      emit({ checked: false, updateAvailable: last.updateAvailable ?? false, note: "今天已检查过更新。" });
      return;
    }

    const local = runGit(["rev-parse", "HEAD"]);
    const remote = runGit(["ls-remote", "origin", "HEAD"]);
    if (!local.ok || !remote.ok || !remote.stdout) {
      // Offline or not a git checkout: skip quietly and retry tomorrow-ish (do not
      // record the date so a transient failure does not suppress the daily check).
      emit({ checked: false, updateAvailable: false, note: "无法检查更新（离线或非 git 安装），已跳过。" });
      return;
    }
    const remoteCommit = remote.stdout.split(/\s/)[0];
    const updateAvailable = remoteCommit !== local.stdout;
    fs.mkdirSync(getStateDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ date: today, updateAvailable, remoteCommit }), { mode: 0o600 });
    emit({ checked: true, updateAvailable, localCommit: local.stdout, remoteCommit });
  });

// ---------------------------------------------------------------- session (task-scoped ChatGPT conversations)
const session = program.command("session").description("Bind one ordinary ChatGPT conversation to each workspace and Codex task");

function resolvedSessionTaskId(explicitTaskId?: string) {
  return resolveCodexTaskId(explicitTaskId);
}

session.command("get", { isDefault: true })
  .description("Show the task-scoped ChatGPT conversation")
  .option("-w, --workspace <path>").option("--task-id <id>", "stable Codex task id")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; taskId?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const read = readSessionRegistry(workspace.id);
    const task = readTaskSession(workspace.id, resolved.taskId);
    const provision = read.registry.provisions.find((entry) => entry.taskId === resolved.taskId) ?? null;
    const result = {
      ok: true,
      workspaceId: workspace.id,
      taskId: resolved.taskId,
      taskIdSource: resolved.source,
      generatedTaskId: resolved.generated,
      task,
      legacyProvision: provision ? { provisionId: provision.provisionId, creationState: provision.creationState } : null,
      projectUrl: read.registry.projectUrl ?? null,
      connectorName: read.registry.connectorName ?? null,
      legacyDetected: read.legacyDetected,
      requiresPoolClaim: !task || task.bindingState === "unavailable",
      requiresManualRetirement: task?.bindingState === "quarantined",
      requiresSettingsConfirmation: Boolean(task && task.bindingState === "bound" && task.settingsSource !== "user_confirmed"),
      requiresWorkspaceVerification: Boolean(task && task.bindingState === "bound" && task.verificationState !== "ready"),
      deliveryReadbackPhase: task ? deliveryReadbackPhase(task) : "none",
    };
    if (opts.json) say(JSON.stringify(result));
    else {
      say(`工作区：${workspace.id}`);
      say(`任务：${resolved.taskId}${resolved.generated ? "（新生成，请在本任务内复用）" : ""}`);
      if (read.legacyDetected) say("检测到旧版会话记录；当前任务从新的人工建档开始。");
      if (!task) say("当前任务尚未绑定普通 ChatGPT 会话。");
      else {
        say(`对话：${task.url}`);
        say(`代次：${task.generation} / ${task.bindingState}`);
        say(`思考：${task.thinkingLevel ?? "待确认"} / ${task.settingsSource}${task.proMode ? " / Pro" : ""}`);
        say(`验证：${task.verificationState}`);
        say(`通道：${task.channelState}`);
      }
    }
  });

session.command("migrate")
  .description("Atomically migrate legacy pool and task records into the global assignment ledger")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    const result = await migrateSessionLedger();
    const payload = {
      ok: true,
      migrated: result.migrated,
      registryCount: result.ledger.registries.length,
      poolEntryCount: result.ledger.pool.entries.length,
    };
    if (opts.json) say(JSON.stringify(payload));
    else check(payload.migrated
      ? `已迁移 ${payload.registryCount} 个工作区与 ${payload.poolEntryCount} 个备用 Chat`
      : "全局归属账本已是当前版本");
  });

session.command("restore")
  .description("Restore a legacy read-miss retirement after exact Chat identity readback")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--conversation-id <id>")
  .requiredOption("--observed-task-id <id>")
  .requiredOption("--observed-workspace-id <id>")
  .requiredOption("--confirm", "confirm that exact read_thread identity was verified")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string; taskId?: string; conversationId: string;
    observedTaskId: string; observedWorkspaceId: string; confirm: boolean; json: boolean;
  }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    if (opts.observedTaskId !== resolved.taskId || opts.observedWorkspaceId !== workspace.id) {
      throw new Error("observed exact Chat identity does not match the requested task");
    }
    const task = await restoreTaskConversation(workspace.id, resolved.taskId, opts.conversationId);
    if (opts.json) say(JSON.stringify({ ok: true, workspaceId: workspace.id, taskId: resolved.taskId, taskIdSource: resolved.source, task }));
    else check(`已恢复第 ${task.generation} 代精确 Chat；下一步执行恢复探测和 workspace_info 核对`);
  });

const pool = session.command("pool").description("Manage manually prepared global standby Chats");

pool.command("status", { isDefault: true })
  .description("Show available, claimed and retired standby Chats")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const standby = readStandbyPool();
    const payload = {
      ok: true,
      projectId: standby.projectId,
      entries: standby.entries,
      available: standby.entries.filter((entry) => entry.status === "available").length,
      claimed: standby.entries.filter((entry) => entry.status === "claimed").length,
    };
    if (opts.json) say(JSON.stringify(payload));
    else say(`备用 Chat：可用 ${payload.available}，已领取 ${payload.claimed}`);
  });

pool.command("import")
  .description("Import one Chat verified by list_threads and read_thread as a standby Chat")
  .requiredOption("--conversation-id <id>")
  .requiredOption("--project-id <id>")
  .requiredOption("--marker-message-id <id>")
  .requiredOption("--marker-text <text>", "exact raw user marker text returned by read_thread")
  .option("--created-at <iso>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { conversationId: string; projectId: string; markerMessageId: string; markerText: string; createdAt?: string; json: boolean }) => {
    const entry = await importStandbyConversation({
      conversationId: opts.conversationId,
      projectId: opts.projectId,
      markerText: opts.markerText,
      markerMessageId: opts.markerMessageId,
      markerRole: "user",
      createdAt: opts.createdAt,
    });
    if (opts.json) say(JSON.stringify({ ok: true, entry }));
    else check(`已导入备用 Chat：${entry.conversationId}`);
  });

pool.command("claim")
  .description("Claim one compatible standby Chat for this Codex task and issue its route capability")
  .option("-w, --workspace <path>")
  .option("--task-id <id>")
  .option("--pro", "this task explicitly requests Pro", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; taskId?: string; pro: boolean; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(root);
    const resolved = resolvedSessionTaskId(opts.taskId);
    const routed = await ensureWorkspaceRouter(root);
    const connectorName = readLastEndpoint(routed.anchor.id)?.connectorName ?? connectorNameFor({
      workspaceName: routed.anchor.name,
      workspaceId: routed.anchor.id,
      hadEndpointBefore: true,
    });
    const claimed = await claimStandbyConversation({
      workspaceId: workspace.id,
      taskId: resolved.taskId,
      connectorName,
      workspaceName: workspace.name,
      branch: gitInfo(workspace.root).branch,
      userExplicitPro: opts.pro,
    });
    let routeToken: string | null = null;
    let task = claimed.task;
    const activeRoute = task.routeCapabilityId
      ? readWorkspaceRouter()?.capabilities.find((candidate) =>
        candidate.id === task.routeCapabilityId &&
        candidate.workspaceId === workspace.id &&
        candidate.taskId === resolved.taskId &&
        candidate.conversationId === task.conversationId &&
        !candidate.revokedAt && Date.parse(candidate.expiresAt) > Date.now()
      )
      : undefined;
    // A pending Boot Prompt needs a fresh raw token that the coordinator can
    // place in that exact Chat. Reissuing it updates the task owner id, so an
    // interrupted earlier preparation never causes a second pool claim.
    if (!task.pendingMessageId && (!activeRoute || task.verificationState !== "ready")) {
      const route = await issueRouteCapability({
        workspaceId: workspace.id,
        taskId: resolved.taskId,
        conversationId: task.conversationId,
      });
      task = await attachTaskRouteCapability(workspace.id, resolved.taskId, route.id);
      routeToken = route.token;
    }
    const payload = {
      ok: true,
      workspaceId: workspace.id,
      taskId: resolved.taskId,
      taskIdSource: resolved.source,
      reused: claimed.reused,
      task,
      entry: claimed.entry,
      routeToken,
      nextAction: task.verificationState === "ready" ? "send_task_message" : "send_boot_prompt",
    };
    if (opts.json) say(JSON.stringify(payload));
    else check(claimed.reused ? "已复用本任务的备用 Chat" : "已领取备用 Chat；发送 Boot Prompt 后核对 workspace_info");
  });

pool.command("quarantine")
  .description("Quarantine an invalid or removed standby Chat")
  .requiredOption("--conversation-id <id>")
  .requiredOption("--reason <reason>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { conversationId: string; reason: string; json: boolean }) => {
    const entry = await quarantineStandbyConversation(opts.conversationId, opts.reason);
    if (opts.json) say(JSON.stringify({ ok: true, entry }));
    else check(`备用 Chat 已隔离：${entry.conversationId}`);
  });
session.command("confirm-workspace")
  .description("Promote a user-confirmed binding after workspace_info matches")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--observed-workspace-id <id>")
  .requiredOption("--observed-connector-name <name>")
  .requiredOption("--observed-workspace-name <name>")
  .option("--observed-branch <branch>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: {
    workspace?: string; taskId?: string; observedWorkspaceId: string; observedConnectorName: string;
    observedWorkspaceName: string; observedBranch?: string; json: boolean;
  }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const task = await confirmTaskWorkspace(
      workspace.id,
      resolved.taskId,
      opts.observedWorkspaceId,
      opts.observedConnectorName,
      opts.observedWorkspaceName,
      opts.observedBranch ?? null
    );
    if (opts.json) say(JSON.stringify({ ok: true, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check("工作区和连接器已核对；会话进入 ready");
  });

session.command("mark-unavailable")
  .description("Explicitly retire a task conversation and require a replacement generation")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--reason <reason>")
  .requiredOption("--confirm", "confirm explicit task Chat retirement")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; taskId?: string; reason: string; confirm: boolean; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const task = await markTaskUnavailable(workspace.id, resolved.taskId, opts.reason);
    if (opts.json) say(JSON.stringify({ ok: true, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check(`第 ${task.generation} 代会话已归档；下一次建档将创建新一代`);
  });

session.command("host-control")
  .description("Record current executor tool availability or exact Chat recovery; never sends a message")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--result <result>", "probe, read-ok, timeout, call-failed, or not-invoked")
  .option("--tools <names>", "comma-separated callable host tool names; use none if both are absent")
  .option("--conversation-id <id>")
  .option("--observed-task-id <id>").option("--observed-workspace-id <id>")
  .option("--message-id <id>")
  .option("--confirm-not-invoked", "attest that the send tool was never called for this reservation", false)
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; taskId?: string; result: HostControlObservation["result"]; tools?: string;
    conversationId?: string; observedTaskId?: string; observedWorkspaceId?: string; messageId?: string; confirmNotInvoked: boolean; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    if (opts.result === "not-invoked" && !opts.confirmNotInvoked) throw new Error("HOST_CONTROL_NOT_INVOKED_ATTESTATION_REQUIRED");
    const task = await recordTaskHostControl(workspace.id, resolved.taskId, {
      result: opts.result, tools: opts.tools === "none" ? [] : opts.tools?.split(",").map(x => x.trim()),
      conversationId: opts.conversationId, observedTaskId: opts.observedTaskId,
      observedWorkspaceId: opts.observedWorkspaceId, messageId: opts.messageId,
    });
    const status = task.hostControl!.status;
    const nextAction = status === "tools_missing" ? "restore_host_tools_then_read_bound_chat" :
      status === "ready" ? (task.pendingMessageId ? "read_pending_message_do_not_resend" : "begin_send") : "probe_then_read_bound_chat";
    const result = { ok: status === "ready", owner: "codex_host", status, nextAction,
      workspaceId: workspace.id, task, reserved: Boolean(task.pendingMessageId),
      accepted: Boolean(task.pendingMessageId && task.sendAcceptedAt),
      delivered: Boolean(task.pendingMessageId && task.lastDeliveredMessageId === task.pendingMessageId),
      replied: false };
    say(opts.json ? JSON.stringify(result) : `${status}: ${nextAction}`);
  });

session.command("record-read")
  .description("Record the health of the saved exact ChatGPT conversation")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--result <result>", "ok, missing, gone, or timeout")
  .option("--reason <reason>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; taskId?: string; result: string; reason?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    if (!/^(ok|missing|gone|timeout)$/u.test(opts.result)) {
      throw new Error("read result must be ok, missing, gone, or timeout");
    }
    const task = await recordTaskReadResult(
      workspace.id,
      resolved.taskId,
      opts.result as "ok" | "missing" | "gone" | "timeout",
      opts.reason ?? ""
    );
    if (opts.json) {
      say(JSON.stringify({
        ok: true,
        workspaceId: workspace.id,
        taskIdSource: resolved.source,
        replacementRequired: task.bindingState === "unavailable",
        task,
      }));
    } else if (task.bindingState === "unavailable") {
      say("已达到会话替换条件；下一步重新建档。");
    } else {
      say(`读取状态：${task.channelState}；连续缺失 ${task.consecutiveReadFailures} 次`);
    }
  });

function addChannelCommandOptions(command: Command): Command {
  return command.option("-w, --workspace <path>").option("--task-id <id>").requiredOption("--message-id <id>").option("--json", "machine-readable output", false);
}

function addObservedIdentityOptions(command: Command): Command {
  return command
    .requiredOption("--observed-task-id <id>")
    .requiredOption("--observed-workspace-id <id>")
    .requiredOption("--observed-iteration <n>");
}

function parseReceiptIteration(value: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("iteration must be a non-negative safe decimal integer");
  }
  return Number(value);
}

addChannelCommandOptions(session.command("begin-send").description("Atomically reserve one outbound ChatGPT message"))
  .requiredOption("--iteration <n>")
  .option("--probe", "allow one recovery probe for a degraded channel", false)
  .option("--bootstrap", "reserve the workspace_info boot message before ready", false)
  .option("--review-head <sha>", "bind this review to an exact full Git HEAD")
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; iteration: string; probe: boolean; bootstrap: boolean; reviewHead?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const current = readTaskSession(workspace.id, resolved.taskId);
    if (current?.hostControl?.status !== "ready" ||
      !Number.isFinite(Date.parse(current.hostControl.checkedAt)) ||
      Date.now() - Date.parse(current.hostControl.checkedAt) > 60_000 || Date.parse(current.hostControl.checkedAt) > Date.now()) {
      throw new Error("HOST_CONTROL_PREFLIGHT_REQUIRED: record current callable tools and exact bound Chat readback before begin-send");
    }
    const task = await beginTaskSend(
      workspace.id,
      resolved.taskId,
      opts.messageId,
      parseReceiptIteration(opts.iteration),
      { probe: opts.probe, bootstrap: opts.bootstrap, reviewHead: opts.reviewHead }
    );
    if (opts.json) say(JSON.stringify({ ok: true, reserved: true, accepted: false, delivered: false, replied: false, identityVerified: false, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check(`已保留发送 ${task.pendingMessageId}；尚未确认送达`);
  });

addChannelCommandOptions(session.command("confirm-send-accepted").description("Record that the direct ChatGPT host accepted the outbound request"))
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const task = await confirmTaskSendAccepted(workspace.id, resolved.taskId, opts.messageId);
    if (opts.json) say(JSON.stringify({ ok: true, reserved: true, accepted: true, delivered: false, replied: false, identityVerified: false, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check(`宿主已接受 ${task.pendingMessageId}；正在等待 ChatGPT 显示该消息`);
  });

addChannelCommandOptions(session.command("record-delivery-pending").description("Keep an accepted direct message in flight after a short readback window"))
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const task = await recordTaskDeliveryPending(workspace.id, resolved.taskId, opts.messageId);
    if (opts.json) say(JSON.stringify({ ok: true, reserved: true, accepted: true, delivered: false, pending: true, replied: false, identityVerified: false, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else say(`消息仍在等待显示：${task.pendingMessageId}`);
  });

addObservedIdentityOptions(addChannelCommandOptions(session.command("confirm-delivery").description("Confirm an outbound message was observed in ChatGPT")))
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; observedTaskId: string; observedWorkspaceId: string; observedIteration: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const current = readTaskSession(workspace.id, resolved.taskId);
    if (!current?.pendingMessageId || current.pendingIteration === undefined) throw new Error("task has no in-flight message");
    assertReceiptIdentity(
      { messageId: current.pendingMessageId, taskId: current.taskId, workspaceId: workspace.id, iteration: current.pendingIteration },
      { messageId: opts.messageId, taskId: opts.observedTaskId, workspaceId: opts.observedWorkspaceId, iteration: parseReceiptIteration(opts.observedIteration) }
    );
    const task = await confirmTaskDelivery(workspace.id, resolved.taskId, opts.messageId);
    if (opts.json) say(JSON.stringify({ ok: true, accepted: Boolean(current.sendAcceptedAt), delivered: true, replied: false, identityVerified: false, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check(`已确认送达 ${task.lastDeliveredMessageId}；正在等待回复`);
  });

addObservedIdentityOptions(addChannelCommandOptions(session.command("confirm-reply").description("Confirm a matching ChatGPT reply and complete the iteration")))
  .requiredOption("--state <state>")
  .option("--observed-review-head <sha>", "exact REVIEW_HEAD echoed by the reply")
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; observedTaskId: string; observedWorkspaceId: string; observedIteration: string; state: string; observedReviewHead?: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const current = readTaskSession(workspace.id, resolved.taskId);
    if (!current?.pendingMessageId || current.pendingIteration === undefined) throw new Error("task has no in-flight message");
    assertReceiptIdentity(
      { messageId: current.pendingMessageId, taskId: current.taskId, workspaceId: workspace.id, iteration: current.pendingIteration },
      { messageId: opts.messageId, taskId: opts.observedTaskId, workspaceId: opts.observedWorkspaceId, iteration: parseReceiptIteration(opts.observedIteration) }
    );
    const task = await confirmTaskReply(workspace.id, resolved.taskId, opts.messageId, opts.state, opts.observedReviewHead);
    if (opts.json) say(JSON.stringify({ ok: true, accepted: Boolean(current.sendAcceptedAt), delivered: true, replied: true, identityVerified: true, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else check(`已确认回复；任务迭代推进到 ${task.iteration}`);
  });

addChannelCommandOptions(session.command("fail-delivery").description("Record an explicit terminal host failure and its binding state"))
  .requiredOption("--kind <kind>", "host_rejected, conversation_gone, or identity_mismatch")
  .requiredOption("--reason <reason>")
  .action(async (opts: { workspace?: string; taskId?: string; messageId: string; kind: string; reason: string; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const current = readTaskSession(workspace.id, resolved.taskId);
    const task = await failTaskDelivery(workspace.id, resolved.taskId, opts.messageId, opts.kind, opts.reason);
    if (opts.json) say(JSON.stringify({ ok: false, accepted: Boolean(current?.sendAcceptedAt), delivered: current?.lastDeliveredMessageId === opts.messageId, replied: false, identityVerified: false, workspaceId: workspace.id, taskIdSource: resolved.source, task }));
    else if (task.bindingState === "unavailable") say(`会话已退役：${task.replacementReason}`);
    else if (task.bindingState === "quarantined") say(`会话已隔离：${task.lastDeliveryError}`);
    else say(`通道已降级：${task.lastDeliveryError}`);
  });

session.command("new-message-id").description("Generate a unique C2C delivery receipt id")
  .option("--json", "machine-readable output", false)
  .action((opts: { json: boolean }) => {
    const messageId = newMessageId();
    if (opts.json) say(JSON.stringify({ ok: true, messageId })); else say(messageId);
  });

session.command("clear").description("Retire this task's ChatGPT conversation while preserving its permanent ownership record")
  .option("-w, --workspace <path>").option("--task-id <id>")
  .requiredOption("--confirm", "confirm explicit retirement of this task Chat")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { workspace?: string; taskId?: string; confirm: boolean; json: boolean }) => {
    const workspace = new Workspace(resolveWorkspace(opts.workspace));
    const resolved = resolvedSessionTaskId(opts.taskId);
    const result = await clearTaskSession(workspace.id, resolved.taskId);
    if (opts.json) say(JSON.stringify({ ok: true, workspaceId: workspace.id, taskId: resolved.taskId, taskIdSource: resolved.source, ...result }));
    else if (!result.cleared) say("当前任务尚未记录 ChatGPT 会话。");
    else check("已归档当前任务会话；永久归属记录已保留");
  });

const runtime = program.command("runtime").description("Diagnose the managed OpenAI runtime without exposing credentials");

runtime.command("diagnose", { isDefault: true })
  .description("Verify the managed OpenAI runtime through its canonical DPAPI credential")
  .option("-w, --workspace <path>")
  .option("--runtime-alias <alias>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; runtimeAlias?: string; json: boolean }) => {
    const anchor = routerAnchorForWorkspace(resolveWorkspace(opts.workspace));
    const runtimeAlias = opts.runtimeAlias?.trim() || `c2c-${anchor.id}`;
    const runtime = runtimeStatusSummary(runtimeAlias);
    const payload = {
      ok: true,
      anchorWorkspaceId: anchor.id,
      runtimeAlias,
      runtime,
    };
    if (opts.json) say(JSON.stringify(payload));
    else {
      say(`运行时：${runtimeAlias}`);
      say(`凭据来源：${runtime.credentialSource}`);
      say(`凭据状态：${runtime.credentialState}`);
      say(`健康状态：process=${runtime.processRunning} healthy=${runtime.healthy} ready=${runtime.ready} stale=${runtime.stale}`);
    }
  });

runtime.command("repair-profile")
  .description("Atomically replace a stale C2C token-file reference in the persisted runtime profile")
  .option("-w, --workspace <path>")
  .option("--runtime-alias <alias>")
  .option("--profile-file <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; runtimeAlias?: string; profileFile?: string; json: boolean }) => {
    const anchor = routerAnchorForWorkspace(resolveWorkspace(opts.workspace));
    const runtimeAlias = opts.runtimeAlias?.trim() || `c2c-${anchor.id}`;
    const profileFile = opts.profileFile ? path.resolve(opts.profileFile) : defaultRuntimeProfileFile(runtimeAlias);
    const before = diagnoseRuntimeHeader({
      canonicalTokenFile: openAITunnelTokenFile(anchor.id),
      profileFile,
      environmentHeaders: undefined,
    });
    if (before.source !== "profile" || before.state !== "legacy_path" || !before.configuredTokenFile) {
      throw new Error("runtime profile has no stale C2C token-file reference to repair");
    }
    const header = repairRuntimeProfileHeader({
      profileFile,
      expectedTokenFile: before.configuredTokenFile,
      canonicalTokenFile: before.canonicalTokenFile,
    });
    const payload = { ok: true, runtimeAlias, header, restartRequired: true };
    if (opts.json) say(JSON.stringify(payload));
    else check("运行时 profile 的令牌文件引用已原子更新；请重连原 alias");
  });

runtime.command("repair-user-environment")
  .description("Atomically replace the stale Windows user-environment C2C token-file reference")
  .option("-w, --workspace <path>")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; json: boolean }) => {
    const anchor = routerAnchorForWorkspace(resolveWorkspace(opts.workspace));
    const result = repairWindowsUserRuntimeHeader({ canonicalTokenFile: openAITunnelTokenFile(anchor.id) });
    const payload = {
      ok: true,
      anchorWorkspaceId: anchor.id,
      previousTokenFile: result.previousTokenFile,
      canonicalTokenFile: result.canonicalTokenFile,
      changed: result.changed,
      restartCodexRequired: result.changed,
    };
    if (opts.json) say(JSON.stringify(payload));
    else check(result.changed
      ? "用户环境中的旧令牌文件路径已更新；重启 Codex 后生效"
      : "用户环境中的令牌文件路径已是当前路径");
  });

program
  .command("record", { hidden: true })
  .description("Record a Codex execution summary (used by the Skill)")
  .option("-w, --workspace <path>")
  .requiredOption("--task <id>")
  .requiredOption("--iteration <n>")
  .option("--changed-files <filesOrCount>", "comma-separated files or a count", "0")
  .option("--tests <summary>", "e.g. '27 passed'")
  .option("--exit-status <status>", "ok | failed | blocked", "ok")
  .option("--notes <text>")
  .action(
    (opts: {
      workspace?: string;
      task: string;
      iteration: string;
      changedFiles: string;
      tests?: string;
      exitStatus: string;
      notes?: string;
    }) => {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const changed = /^\d+$/.test(opts.changedFiles)
        ? parseInt(opts.changedFiles, 10)
        : opts.changedFiles.split(",").map((file) => file.trim()).filter(Boolean);
      appendExecutionRecord(workspace.id, {
        taskId: opts.task,
        iteration: parseInt(opts.iteration, 10),
        changedFiles: changed,
        tests: opts.tests ?? null,
        exitStatus: opts.exitStatus,
        timestamp: new Date().toISOString(),
        notes: opts.notes,
      });
      check("已记录执行摘要");
    }
  );

const tunnelCmd = program.command("tunnel").description("Choose or inspect the public connection for this workspace");

tunnelCmd
  .command("status", { isDefault: true })
  .description("Show whether this workspace still needs a one-time connection choice")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "optional domain, used to preview the stable hostname")
  .option("--json", "machine-readable output", false)
  .action((opts: { workspace?: string; zone?: string; json: boolean }) => {
    try {
      const workspace = new Workspace(resolveWorkspace(opts.workspace));
      const payload = tunnelChoicePayload(workspace, opts.zone);
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (payload.needsChoice) say(TUNNEL_CHOICE_PROMPT);
      else if (payload.namedReady) check(`固定域名：${payload.hostname}`);
      else say("当前使用临时地址。");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("choose")
  .description("Remember quick vs named, and provision a named hostname when asked")
  .requiredOption("--mode <mode>", "quick or named")
  .option("-w, --workspace <path>")
  .option("--zone <domain>", "Cloudflare domain for a named hostname")
  .option("--hostname <hostname>", "override the default c2c-<project>.<zone>")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { mode: string; workspace?: string; zone?: string; hostname?: string; json: boolean }) => {
    const root = resolveWorkspace(opts.workspace);
    try {
      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      if (mode !== "quick" && mode !== "named") {
        throw new Error("mode must be quick or named");
      }

      if (mode === "quick") {
        const stateBox: { value?: ReturnType<typeof chooseQuickTunnel> } = {};
        await switchWorkspaceTransport(root, "cloudflare", {
          forceFence: true,
          afterFence: () => {
            stateBox.value = chooseQuickTunnel(workspace.id);
          },
        });
        const state = stateBox.value;
        if (!state) throw new Error("Cloudflare quick-tunnel preference was not committed");
        const payload = { ...tunnelChoicePayload(workspace), state };
        if (opts.json) say(JSON.stringify(payload));
        else check("已选用临时地址");
        return;
      }

      const zone = parseZoneInput(opts.zone ?? "");
      if (!zone) {
        const payload = {
          ok: false,
          need: "zone",
          userMessage: "请告诉我已经加在 Cloudflare 上的域名，例如 example.com",
          loginPrompt: NAMED_LOGIN_PROMPT,
        };
        if (opts.json) {
          say(JSON.stringify(payload));
          return;
        }
        say(payload.userMessage);
        return;
      }

      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const resultBox: { value?: Awaited<ReturnType<typeof provisionNamedTunnel>> } = {};
      await switchWorkspaceTransport(root, "cloudflare", {
        forceFence: true,
        afterFence: async () => {
          resultBox.value = await provisionNamedTunnel({
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            zone,
            hostname: opts.hostname,
          });
        },
      });
      const result = resultBox.value;
      if (!result) throw new Error("Cloudflare named-tunnel preference was not committed");

      const payload = {
        ...tunnelChoicePayload(workspace),
        ok: true,
        fallback: result.fallback,
        userMessage: result.userMessage,
        error: result.error,
        state: result.state,
      };
      if (opts.json) {
        say(JSON.stringify(payload));
        return;
      }
      if (result.fallback) say(result.userMessage ?? "");
      else check(`固定域名已就绪：${result.state.hostname}`);
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

tunnelCmd
  .command("login")
  .description("Open the Cloudflare login window used by a named hostname")
  .option("--json", "machine-readable output", false)
  .action(async (opts: { json: boolean }) => {
    try {
      if (!opts.json) say(NAMED_LOGIN_PROMPT);
      const account = new ProcessCloudflaredAccount();
      await account.login();
      const payload = { ok: true, loggedIn: hasCloudflaredCert() };
      if (opts.json) say(JSON.stringify(payload));
      else check("Cloudflare 已登录");
    } catch (error) {
      handleCliError(error, opts.json);
    }
  });

function handleCliError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    say(JSON.stringify({ ok: false, error: message }));
  } else if (message.startsWith("NEED_CLOUDFLARED")) {
    say("需要你完成一步：");
    say("");
    say("尚未安装安全连接组件 cloudflared。");
    say("macOS 用户可运行：brew install cloudflared");
    say("完成后再试一次即可。");
  } else {
    cross(message);
  }
  process.exitCode = 1;
}

program.parseAsync(process.argv).catch((error: Error) => {
  cross(error.message);
  process.exit(1);
});
