import { afterEach, describe, expect, it } from "vitest";
import {
  claimStandbyConversation,
  importStandbyConversation,
  readStandbyPool,
} from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateRoot: string | undefined;

afterEach(() => {
  if (stateRoot) cleanup(stateRoot);
  stateRoot = undefined;
});

function reset(): void {
  stateRoot = isolateStateDir();
}

const projectId = "g-p-standbypool123";

describe("global standby Chat pool", () => {
  it("claims FIFO chats once across concurrent workspaces and records task ownership", async () => {
    reset();
    await importStandbyConversation({
      conversationId: "standby-first", projectId, marker: "C2C_STANDBY_READY",
      markerMessageId: "marker-first", markerRole: "user", createdAt: "2026-01-01T00:00:00.000Z",
    });
    await importStandbyConversation({
      conversationId: "standby-second", projectId, marker: "C2C_STANDBY_READY",
      markerMessageId: "marker-second", markerRole: "user", createdAt: "2026-01-02T00:00:00.000Z",
    });

    const [alpha, beta] = await Promise.all([
      claimStandbyConversation({ workspaceId: "alpha-workspace", taskId: "alpha-task", connectorName: "C2C Alpha", workspaceName: "alpha", branch: "main" }),
      claimStandbyConversation({ workspaceId: "beta-workspace", taskId: "beta-task", connectorName: "C2C Beta", workspaceName: "beta", branch: "main" }),
    ]);

    expect(new Set([alpha.task.conversationId, beta.task.conversationId])).toEqual(new Set(["standby-first", "standby-second"]));
    expect(alpha.task.settingsSource).toBe("user_confirmed");
    expect(alpha.task.thinkingLevel).toBe("xhigh");
    expect(alpha.task.proMode).toBe(false);
    expect(readStandbyPool().entries.filter((entry) => entry.status === "claimed")).toHaveLength(2);
  });

  it("rejects assistant markers, wrong projects, duplicate conversations, and Pro claims without an explicit request", async () => {
    reset();
    await expect(importStandbyConversation({
      conversationId: "assistant-marker", projectId, marker: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "assistant",
    })).rejects.toThrow(/user message/);
    await importStandbyConversation({
      conversationId: "normal-marker", projectId, marker: "C2C_STANDBY_READY", markerMessageId: "marker-normal", markerRole: "user",
    });
    await expect(importStandbyConversation({
      conversationId: "normal-marker", projectId, marker: "C2C_STANDBY_READY", markerMessageId: "marker-duplicate", markerRole: "user",
    })).rejects.toThrow(/already exists/);
    await expect(importStandbyConversation({
      conversationId: "wrong-project", projectId: "g-p-anotherproject", marker: "C2C_STANDBY_READY", markerMessageId: "marker-wrong", markerRole: "user",
    })).rejects.toThrow(/another ChatGPT Project/);
    await importStandbyConversation({
      conversationId: "pro-marker", projectId, marker: "C2C_STANDBY_READY_PRO", markerMessageId: "marker-pro", markerRole: "user",
    });
    const normal = await claimStandbyConversation({ workspaceId: "workspace", taskId: "normal-task", connectorName: "C2C", workspaceName: "repo", branch: "main" });
    expect(normal.task.conversationId).toBe("normal-marker");
    await expect(claimStandbyConversation({ workspaceId: "workspace", taskId: "pro-task", connectorName: "C2C", workspaceName: "repo", branch: "main" })).rejects.toThrow(/POOL_EXHAUSTED/);
    const pro = await claimStandbyConversation({ workspaceId: "workspace", taskId: "pro-task", connectorName: "C2C", workspaceName: "repo", branch: "main", userExplicitPro: true });
    expect(pro.task.conversationId).toBe("pro-marker");
    expect(pro.task.proMode).toBe(true);
  });
});
