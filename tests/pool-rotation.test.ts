import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { attachTaskRouteCapability, beginTaskSend, claimStandbyConversation, confirmTaskDelivery,
  confirmTaskReply, confirmTaskWorkspace, importStandbyConversation, newMessageId, readReclaimCandidates,
  readTaskSession, resumeTaskSession, sessionLedgerFile, validateReclaimObservations } from "../src/session/state.js";
import { createWorkspaceRouter, issueRouteCapability, resolveRouteCapability } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let state: string, workspace: string, workspaceId: string;
const claim = (taskId: string, id = workspaceId, observations?: ReturnType<typeof observationsFor>) =>
  claimStandbyConversation({ workspaceId: id, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main", reclaimObservations: observations });
async function boot(taskId: string, id = workspaceId) {
  const msg = newMessageId();
  await beginTaskSend(id, taskId, msg, 0, { bootstrap: true });
  await confirmTaskDelivery(id, taskId, msg);
  await confirmTaskReply(id, taskId, msg, "DONE");
  await confirmTaskWorkspace(id, taskId, { workspaceId: id, routeTaskId: taskId, workspaceName: "repo", branch: "main" });
}
function observationsFor() {
  return readReclaimCandidates().candidates.map(row => ({ conversationId: row.conversationId,
    workspaceId: row.workspaceId!, taskId: row.taskId!, generation: row.generation!, assignmentEpoch: row.assignmentEpoch,
    observedAt: new Date().toISOString(), taskStatus: "idle" as const, chatStatus: "idle" as const, readbackClean: true as const }));
}
const cli = (...args: string[]) => spawnSync(process.execPath,
  ["--import", "tsx/esm", "src/cli/index.ts", "session", "pool", ...args],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });

beforeEach(async () => {
  state = isolateStateDir(); workspace = makeTmpDir("pool-rotation"); makeGitRepo(workspace);
  const router = await createWorkspaceRouter(workspace);
  workspaceId = (await router.register(workspace)).workspaceId;
  await importStandbyConversation({ conversationId: "rotation-chat", projectId: "g-p-rotation",
    markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claim("old-owner"); await boot("old-owner");
});
afterEach(() => { cleanup(state); cleanup(workspace); });

it.each([true, false])("atomically rotates with same workspace=%s and invalidates the old route", async same => {
  const oldRoute = await issueRouteCapability({ workspaceId, taskId: "old-owner", conversationId: "rotation-chat" });
  await attachTaskRouteCapability(workspaceId, "old-owner", oldRoute.id);
  const observed = observationsFor();
  const target = same ? workspaceId : "target-workspace";
  const result = await claim("new-owner", target, observed);
  expect(result.task.conversationId).toBe("rotation-chat");
  expect(readTaskSession(workspaceId, "old-owner")).toBeNull();
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  expect(new Set(ledger.registries.map((r: { workspaceId: string }) => r.workspaceId)).size).toBe(ledger.registries.length);
  expect(ledger.assignmentHistory.at(-1)).toMatchObject({ reason: "pool_reclaimed", taskId: "old-owner" });
  expect(result.entry.assignmentEpoch).toBe(observed[0].assignmentEpoch + 1);
  await expect(resolveRouteCapability(oldRoute.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
  await boot("new-owner", target);
  expect(readTaskSession(target, "new-owner")?.verificationState).toBe("ready");
});

it.each(["lease", "pending"])("rejects a candidate that acquired %s after observation without writes", async kind => {
  const observed = observationsFor();
  if (kind === "lease") await resumeTaskSession(workspaceId, "old-owner");
  else await beginTaskSend(workspaceId, "old-owner", newMessageId(), 1);
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(claim("new-owner", workspaceId, observed)).rejects.toThrow("POOL_BUSY");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  expect(readReclaimCandidates().candidates).toHaveLength(0);
  expect(readReclaimCandidates().excluded[0].exclusionReason).toBe(kind === "lease" ? "active_lease" : "pending_or_degraded");
});

it("permits only one claimant for a shared observation", async () => {
  const observed = observationsFor();
  const results = await Promise.allSettled([claim("new-one", workspaceId, observed), claim("new-two", workspaceId, observed)]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  expect(ledger.assignmentHistory).toHaveLength(1);
  expect(ledger.registries[0].tasks).toHaveLength(1);
});

it.each(["missing", "expired", "future", "epoch", "generation", "task", "chat", "workspace"])(
  "rejects %s evidence without modifying the ledger", async kind => {
    const observed = observationsFor();
    if (kind === "expired") observed[0].observedAt = new Date(Date.now() - 61_000).toISOString();
    if (kind === "future") observed[0].observedAt = new Date(Date.now() + 61_000).toISOString();
    if (kind === "epoch") observed[0].assignmentEpoch++;
    if (kind === "generation") observed[0].generation++;
    if (kind === "task") observed[0].taskId = "wrong";
    if (kind === "chat") observed[0].conversationId = "wrong";
    if (kind === "workspace") observed[0].workspaceId = "wrong";
    const before = fs.readFileSync(sessionLedgerFile(), "utf8");
    await expect(claim("new", workspaceId, kind === "missing" ? undefined : observed)).rejects.toThrow("POOL_OBSERVATION_REQUIRED");
    expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  });

it("strictly rejects malformed or duplicate observations", () => {
  const [valid] = observationsFor();
  for (const invalid of [null, {}, [null], [{ ...valid, generation: "1" }], [{ ...valid, assignmentEpoch: 0.5 }],
    [{ ...valid, observedAt: "bad" }], [{ ...valid, readbackClean: "true" }], [{ ...valid, taskStatus: "active" }],
    [{ ...valid, chatStatus: "active" }], [{ ...valid, taskId: "" }], [valid, valid]]) {
    expect(() => validateReclaimObservations(invalid)).toThrow("RECLAIM_OBSERVATIONS_INVALID");
  }
});

it("CLI exposes read-only candidates and performs rotation from an observation file", async () => {
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const listed = cli("reclaim-candidates", "--json");
  expect(listed.status).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({ hostObservationRequired: true, candidates: [{ taskId: "old-owner", lastState: "DONE" }] });
  expect(listed.stdout).not.toMatch(/routeToken|c2c_route_/);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  const args = ["claim", "-w", workspace, "--task-id", "cli-owner", "--json"];
  const absent = cli(...args);
  expect(absent.status).not.toBe(0);
  expect(absent.stdout + absent.stderr).toContain("POOL_OBSERVATION_REQUIRED");
  const file = path.join(state, "observations.json");
  fs.writeFileSync(file, JSON.stringify(observationsFor()));
  expect(cli(...args, "--reclaim-observations", "[]", "--reclaim-observations-file", file).status).not.toBe(0);
  fs.writeFileSync(file, '[{"readbackClean":"true"}]');
  expect(cli(...args, "--reclaim-observations-file", file).status).not.toBe(0);
  const stale = observationsFor(); stale[0].observedAt = new Date(Date.now() - 61_000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stale));
  expect(cli(...args, "--reclaim-observations-file", file).status).not.toBe(0);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  fs.writeFileSync(file, JSON.stringify(observationsFor()));
  const claimed = cli(...args, "--reclaim-observations-file", file);
  expect(claimed.status, claimed.stderr).toBe(0);
  expect(JSON.parse(claimed.stdout)).toMatchObject({ task: { taskId: "cli-owner", conversationId: "rotation-chat" }, nextAction: "send_boot_prompt" });
  expect(readTaskSession(workspaceId, "old-owner")).toBeNull();
});
