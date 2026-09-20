import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { it, expect } from "vitest";
import { beginTaskSend, claimStandbyConversation, confirmTaskDelivery, confirmTaskReply, confirmTaskWorkspace,
  importStandbyConversation, newMessageId, readTaskSession, recordTaskHostControl, sessionLedgerFile } from "../src/session/state.js";
import { createWorkspaceRouter } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

it("CLI crosses source lease recovery/release, migration preflight and fresh destination BOOT lease", async () => {
  const root = isolateStateDir(), sourceRoot = makeTmpDir("lease-source"), targetRoot = makeTmpDir("lease-target");
  const taskId = "lease-migration-flow", chat = "lease-migration-chat";
  const run = (workspace: string, ...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "-w", workspace, "--json"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: taskId, C2C_INTERNAL_STATE_DIR: "test" } });
  const ok = (workspace: string, ...args: string[]) => {
    const r = run(workspace, ...args); expect(r.status, r.stderr).toBe(0); return JSON.parse(r.stdout);
  };
  try {
    makeGitRepo(sourceRoot); makeGitRepo(targetRoot);
    const router = await createWorkspaceRouter(sourceRoot);
    const source = (await router.register(sourceRoot)).workspaceId, target = (await router.register(targetRoot)).workspaceId;
    await importStandbyConversation({ conversationId: chat, projectId: "g-p-leasemigration", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
    await claimStandbyConversation({ workspaceId: source, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main" });
    const messageId = newMessageId();
    await beginTaskSend(source, taskId, messageId, 0, { bootstrap: true });
    await confirmTaskDelivery(source, taskId, messageId); await confirmTaskReply(source, taskId, messageId, "DONE");
    await confirmTaskWorkspace(source, taskId, { workspaceId: source, routeTaskId: taskId, workspaceName: "repo", branch: "main" });
    await recordTaskHostControl(source, taskId, { result: "probe", tools: ["read_thread", "send_message_to_thread"] });
    await recordTaskHostControl(source, taskId, { result: "read-ok", conversationId: chat, observedTaskId: taskId, observedWorkspaceId: source });
    const sourceUseId = ok(sourceRoot, "resume", "--recover-own").useId;
    expect(ok(targetRoot, "resume", "--recover-own")).toMatchObject({ useId: sourceUseId, nextAction: "release_own_lease_before_workspace_switch" });
    ok(targetRoot, "finish", "--bound-workspace", "--use-id", sourceUseId);
    expect(ok(targetRoot, "get").nextAction).toBe("switch_workspace");
    ok(targetRoot, "switch-workspace", "--from-workspace-id", source, "--expected-generation", "1",
      "--observed-conversation-id", chat, "--observed-task-id", taskId, "--observed-workspace-id", source, "--observed-at", new Date().toISOString());
    const before = fs.readFileSync(sessionLedgerFile(), "utf8");
    const stale = run(targetRoot, "host-control", "--result", "probe", "--tools", "read_thread,send_message_to_thread", "--use-id", sourceUseId);
    expect(JSON.parse(stale.stdout)).toMatchObject({ ok: false, leaseStatus: "conflict" });
    expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
    ok(targetRoot, "host-control", "--result", "probe", "--tools", "read_thread,send_message_to_thread");
    const moved = readTaskSession(target, taskId)!;
    const file = path.join(root, "migration.json");
    fs.writeFileSync(file, JSON.stringify({ taskId, conversationId: chat, fromWorkspaceId: source, toWorkspaceId: target,
      generation: 2, assignmentEpoch: moved.migrationHandshake!.assignmentEpoch, iteration: 0, messageId, state: "DONE",
      chatReadAt: new Date().toISOString(), chatStatus: "idle", readbackClean: true }));
    ok(targetRoot, "host-control", "--result", "migration-read-ok", "--observation-file", file);
    expect(ok(targetRoot, "get").nextAction).toBe("prepare_boot_required");
    const destinationUseId = ok(targetRoot, "resume", "--recover-own").useId;
    expect(destinationUseId).toBeTruthy(); expect(destinationUseId).not.toBe(sourceUseId);
    expect(ok(targetRoot, "prepare-boot", "--expected-generation", "2", "--use-id", destinationUseId)).toMatchObject({ sendAllowed: true, generation: 2 });
  } finally { cleanup(root); cleanup(sourceRoot); cleanup(targetRoot); }
});
