import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { makeGitRepo, makeTmpDir, cleanup, isolateStateDir } from "./helpers.js";
import {
  createWorkspaceRouter,
  issueRouteCapability,
  resolveRouteCapability,
  routerStateFile,
} from "../src/router/state.js";

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
    const alphaRoute = await issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-alpha",
      conversationId: "chat-alpha",
    });
    const betaRoute = await issueRouteCapability({
      workspaceId: betaRegistration.workspaceId,
      taskId: "task-beta",
      conversationId: "chat-beta",
    });

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
  });

  it("rejects expired and malformed capabilities", async () => {
    const state = isolateStateDir();
    dirs.push(state);
    const alpha = workspace("router-expiry-alpha");
    workspace("router-expiry-beta");
    const router = await createWorkspaceRouter(alpha);
    const alphaRegistration = await router.register(alpha);
    const token = await issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-alpha",
      conversationId: "chat-alpha",
    });
    const raw = JSON.parse(fs.readFileSync(routerStateFile(), "utf8")) as { capabilities: { id: string; expiresAt: string }[] };
    raw.capabilities.find((entry) => entry.id === token.id)!.expiresAt = "2000-01-01T00:00:00.000Z";
    fs.writeFileSync(routerStateFile(), JSON.stringify(raw));
    await expect(resolveRouteCapability(token.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
    await expect(issueRouteCapability({
      workspaceId: alphaRegistration.workspaceId,
      taskId: "task-expiry",
      conversationId: "chat-expiry",
      expiresAt: "2000-01-01T00:00:00.000Z",
    })).rejects.toThrow(/expiry/);
  });
});
