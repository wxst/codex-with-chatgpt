from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected exactly one match, found {count}")
    return text.replace(old, new, 1)


# Pin direct dependencies to the exact versions already selected by the audited lockfile.
pkg_path = ROOT / "package.json"
pkg = json.loads(pkg_path.read_text())
pkg["dependencies"] = {
    "@modelcontextprotocol/sdk": "1.30.0",
    "commander": "14.0.3",
    "express": "5.2.1",
    "ignore": "7.0.6",
    "zod": "3.25.76",
}
pkg["devDependencies"] = {
    "@types/express": "5.0.6",
    "@types/node": "22.20.1",
    "tsx": "4.23.12",
    "typescript": "5.9.3",
    "vitest": "3.2.7",
}
pkg_path.write_text(json.dumps(pkg, indent=2) + "\n")


cli_path = ROOT / "src" / "cli" / "index.ts"
cli = cli_path.read_text()

cli = replace_once(
    cli,
    '} from "../tunnel/state.js";\nimport { Logger } from "../logger/index.js";',
    '} from "../tunnel/state.js";\nimport {\n  ensureOpenAITunnelToken,\n  openAITunnelTokenFile,\n  readTransportMode,\n  writeTransportMode,\n  type TransportMode,\n} from "../tunnel/transport-mode.js";\nimport { Logger } from "../logger/index.js";',
    "transport imports",
)

cli = replace_once(
    cli,
    "  port: number;\n  publicUrl: string | null;",
    "  port: number;\n  transportMode: TransportMode;\n  publicUrl: string | null;",
    "AdminInfo transport mode",
)

start = cli.index("async function ensureBridgeAndTunnel(")
end = cli.index("\n\nprogram\n  .name", start)
new_bridge_helper = '''async function ensureBridgeAndTunnel(
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
}'''
cli = cli[:start] + new_bridge_helper + cli[end:]

cli = replace_once(
    cli,
    '''    const logger = new Logger({ name: "bridge", console: true });
    const bridge = await startBridge({
      workspaceRoot: resolveWorkspace(opts.workspace),
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
    });''',
    '''    const logger = new Logger({ name: "bridge", console: true });
    const workspaceRoot = resolveWorkspace(opts.workspace);
    const workspace = new Workspace(workspaceRoot);
    const bridge = await startBridge({
      workspaceRoot,
      port: opts.port ? parseInt(opts.port, 10) : undefined,
      logger,
      transportMode: readTransportMode(workspace.id),
    });''',
    "serve transport mode",
)

cli = replace_once(
    cli,
    '''            pairingCode: pairingResult.code,
            pairingExpiresAt: pairingResult.expiresAt,
            sandbox,
            tunnel: {''',
    '''            transportMode: info.transportMode,
            localMcpUrl: `http://127.0.0.1:${runtime.port}/mcp`,
            openai:
              info.transportMode === "openai"
                ? {
                    headerName: "X-C2C-Tunnel-Token",
                    tokenFile: openAITunnelTokenFile(info.workspaceId),
                    runtimeAlias: `c2c-${info.workspaceId}`,
                    tunnelIdEnv: "CONTROL_PLANE_TUNNEL_ID",
                    runtimeApiKeyEnv: "CONTROL_PLANE_API_KEY",
                  }
                : null,
            pairingCode: info.transportMode === "cloudflare" ? pairingResult.code : null,
            pairingExpiresAt: info.transportMode === "cloudflare" ? pairingResult.expiresAt : null,
            sandbox,
            tunnel: {''',
    "setup JSON transport payload",
)

cli = replace_once(
    cli,
    '''      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      if (mcpUrl) check("安全连接已建立");
      say("");
      say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
      say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
      say("");
      say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      say("如果你在使用 Codex Skill，这一步会自动完成。");''',
    '''      check(`当前项目已识别（${info.workspaceName}）`);
      check("Workspace Bridge 已启动");
      say("");
      if (info.transportMode === "openai") {
        ensureOpenAITunnelToken(info.workspaceId);
        check("默认安全模式：OpenAI Secure MCP Tunnel");
        say(`本机 MCP：http://127.0.0.1:${runtime.port}/mcp`);
        say(`本机认证文件：${openAITunnelTokenFile(info.workspaceId)}`);
        say(`运行别名：c2c-${info.workspaceId}`);
        say("");
        say("下一步：用 tunnel-client 把这个本机 MCP 连接到你的 OpenAI Tunnel；ChatGPT 连接器选择 Connection: Tunnel。");
        say("CONTROL_PLANE_API_KEY 只放环境变量，不要粘贴进 ChatGPT 或命令历史。");
      } else {
        if (mcpUrl) check("Cloudflare fallback 已建立");
        say(`连接地址：${mcpUrl ?? `http://127.0.0.1:${runtime.port}/mcp`}`);
        say(`配对码：${pairingResult.code}（${Math.round((pairingResult.expiresAt - Date.now()) / 60000)} 分钟内有效）`);
        say("");
        say("下一步：在 ChatGPT 的连接器设置中添加以上地址（OAuth），并在授权页输入配对码。");
      }
      say("如果你在使用 Codex Skill，这一步会自动完成。");''',
    "setup human output",
)

transport_command = '''// ---------------------------------------------------------------- transport

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
        const previous = readTransportMode(workspace.id);
        writeTransportMode(workspace.id, next);
        if (previous !== next && (await findLiveBridge(workspace.id))) {
          await stopBridge(root);
        }
      }

      const mode = readTransportMode(workspace.id);
      if (mode === "openai") ensureOpenAITunnelToken(workspace.id);
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
                tunnelIdEnv: "CONTROL_PLANE_TUNNEL_ID",
                runtimeApiKeyEnv: "CONTROL_PLANE_API_KEY",
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

'''
cli = replace_once(
    cli,
    "// ---------------------------------------------------------------- stop / restart\n",
    transport_command + "// ---------------------------------------------------------------- stop / restart\n",
    "transport command",
)

cli = replace_once(
    cli,
    '''    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    if (info.tunnel.running && info.tunnel.url) check(`安全连接：${info.tunnel.url}/mcp`);
    else say("· 安全连接：未启用（本地模式）");
    say(`· 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);''',
    '''    check(`Workspace：${info.workspaceName}`);
    check(`Bridge：运行中（端口 ${info.port}）`);
    check(`传输模式：${info.transportMode === "openai" ? "OpenAI Secure MCP Tunnel" : "Cloudflare fallback"}`);
    if (info.transportMode === "openai") {
      say("· 公网 MCP 入口：关闭");
      say("· 本机 MCP：仅 loopback + 每工作区随机令牌可访问");
    } else if (info.tunnel.running && info.tunnel.url) {
      check(`Cloudflare fallback：${info.tunnel.url}/mcp`);
      say(`· OAuth 已授权连接：${info.tokenCount > 0 ? "是" : "否"}`);
    } else {
      say("· Cloudflare fallback：未启动");
    }''',
    "status transport output",
)

# Cloudflare repair logic is inactive unless Cloudflare transport was explicitly selected.
cli = replace_once(
    cli,
    '''    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = tunnelState ? isNamedTunnelReady(tunnelState) : false;''',
    '''    const selectedTransport = workspace ? readTransportMode(workspace.id) : "openai";
    const tunnelState = workspace ? readTunnelState(workspace.id) : null;
    const namedReady = selectedTransport === "cloudflare" && tunnelState ? isNamedTunnelReady(tunnelState) : false;''',
    "doctor selected transport",
)
cli = replace_once(
    cli,
    '''      const expectedPublic = Boolean(lastEndpoint?.publicUrl) || namedReady;''',
    '''      const expectedPublic = info.transportMode === "cloudflare" && (Boolean(lastEndpoint?.publicUrl) || namedReady);''',
    "doctor public expectation",
)
cli = replace_once(
    cli,
    '''    } else if (lastEndpoint?.publicUrl) {''',
    '''    } else if (selectedTransport === "cloudflare" && lastEndpoint?.publicUrl) {''',
    "doctor stopped bridge fallback",
)

cli = replace_once(
    cli,
    '''      const workspace = new Workspace(root);
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);''',
    '''      const workspace = new Workspace(root);
      writeTransportMode(workspace.id, "cloudflare");
      const mode = opts.mode.trim().toLowerCase();
      const previous = readTunnelState(workspace.id);''',
    "Cloudflare choice selects fallback transport",
)

cli_path.write_text(cli)
