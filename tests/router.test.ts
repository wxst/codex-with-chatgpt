import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { makeGitRepo, makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";
import {
  createWorkspaceRouter,
  issueRouteCapability,
  resolveRouteCapability,
  routerStateFile,
} from "../src/router/state.js";
import { attachTaskRouteCapability, claimStandbyConversation, clearTaskSession, importStandbyConversation } from "../src/session/state.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) cleanup(dir);
  delete process.env.C2C_STATE_DIR;
});

function workspace(name: string): string {
  const root = makeTmpDir(name);
  dirs.push(root);
  makeGitRepo(root);
  return root;
}

describe("global workspace router", () => {
  it("resolves concurrent task capabilities to their own registered workspace", async () => {
    const state = isolateStateDir();
    dirs.push(state);
    const alpha = workspace("router-alpha");
    const beta = workspace("router-beta");

    const router = await createWorkspaceRouter(alpha);
    const alphaRegistration = await router.register(alpha);
    const betaRegistration = await router.register(beta);
    await importStandbyConversation({
      conversationId: "chat-alpha", projectId: "g-p-routerpool123", markerText: "C2C_STANDBY_READY",
      markerMessageId: "router-marker-alpha", markerRole: "user",
    });
    await importStandbyConversation({
      conversationId: "chat-beta", projectId: "g-p-routerpool123", markerText: "C2C_STANDBY_READY",
      markerMessageId: "router-marker-beta", markerRole: "user",
    });
    const alphaTask = await claimStandbyConversation({
      workspaceId: alphaRegistration.workspaceId, taskId: "task-alpha", connectorName: "C2C", workspaceName: "alpha", branch: "main",
    });
    const betaTask = await claimStandbyConversation({
      workspaceId: betaRegistration.workspaceId, taskId: "task-beta", connectorName: "C2C", workspaceName: "beta", branch: "main",
    });
    const alphaRoute = await issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-alpha",
      conversationId: alphaTask.task.conversationId,
    });
    const betaRoute = await issueRouteCapability({
      workspaceId: betaRegistration.workspaceId,
      taskId: "task-beta",
      conversationId: betaTask.task.conversationId,
    });
    await attachTaskRouteCapability(alphaRegistration.workspaceId, "task-alpha", alphaRoute.id);
    await attachTaskRouteCapability(betaRegistration.workspaceId, "task-beta", betaRoute.id);

    const [alphaResolved, betaResolved] = await Promise.all([
      resolveRouteCapability(alphaRoute.token),
      resolveRouteCapability(betaRoute.token),
    ]);

    expect(alphaResolved.workspace.id).toBe(alphaRegistration.workspaceId);
    expect(alphaResolved.capability.taskId).toBe("task-alpha");
    expect(betaResolved.workspace.id).toBe(betaRegistration.workspaceId);
    expect(betaResolved.capability.taskId).toBe("task-beta");
    expect(JSON.stringify(await router.read())).not.toContain(alphaRoute.token);
    expect(routerStateFile()).toContain("router");

    await expect(issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "another-task",
      conversationId: alphaTask.task.conversationId,
    })).rejects.toThrow("SESSION_CONVERSATION_OWNER_MISMATCH");

    await clearTaskSession(alphaRegistration.workspaceId, "task-alpha");
    await expect(resolveRouteCapability(alphaRoute.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
  });

  it("rejects expired and malformed capabilities", async () => {
    const state = isolateStateDir();
    dirs.push(state);
    const alpha = workspace("router-expiry-alpha");
    workspace("router-expiry-beta");
    const router = await createWorkspaceRouter(alpha);
    const alphaRegistration = await router.register(alpha);
    await importStandbyConversation({
      conversationId: "chat-alpha", projectId: "g-p-routerpool123", markerText: "C2C_STANDBY_READY",
      markerMessageId: "router-marker-alpha", markerRole: "user",
    });
    const alphaTask = await claimStandbyConversation({
      workspaceId: alphaRegistration.workspaceId, taskId: "task-alpha", connectorName: "C2C", workspaceName: "alpha", branch: "main",
    });
    const token = await issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-alpha",
      conversationId: alphaTask.task.conversationId,
    });
    await attachTaskRouteCapability(alphaRegistration.workspaceId, "task-alpha", token.id);
    const raw = JSON.parse(fs.readFileSync(routerStateFile(), "utf8")) as { capabilities: { id: string; expiresAt: string }[] };
    raw.capabilities.find((entry) => entry.id === token.id)!.expiresAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(routerStateFile(), JSON.stringify(raw));
    await expect(resolveRouteCapability(token.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
    await expect(issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-alpha",
      conversationId: alphaTask.task.conversationId,
      expiresAt: "2000-01-01T00:00:00.000Z",
    })).rejects.toThrow(/expiry/);
  });
});
