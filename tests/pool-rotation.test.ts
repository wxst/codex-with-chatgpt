import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { attachTaskRouteCapability, beginTaskSend, claimStandbyConversation, confirmTaskDelivery,
  confirmTaskReply, confirmTaskWorkspace, importStandbyConversation, newMessageId, readReclaimCandidates,
  readTaskSession, resumeTaskSession, sessionLedgerFile, validateReclaimObservations, failTaskDelivery,
  type BoundRecoveryObservation, type NotLoadedReclaimObservation, type ReclaimObservation } from "../src/session/state.js";
import { createWorkspaceRouter, issueRouteCapability, resolveRouteCapability } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let state: string, workspace: string, workspaceId: string;
const claim = (taskId: string, id = workspaceId, observations?: ReclaimObservation[]) =>
  claimStandbyConversation({ workspaceId: id, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main", reclaimObservations: observations });
async function boot(taskId: string, id = workspaceId) {
  const msg = newMessageId();
  await beginTaskSend(id, taskId, msg, 0, { bootstrap: true, useId: readTaskSession(id, taskId)?.activeUse?.useId });
  await confirmTaskDelivery(id, taskId, msg);
  await confirmTaskReply(id, taskId, msg, "DONE");
  await confirmTaskWorkspace(id, taskId, { workspaceId: id, routeTaskId: taskId, workspaceName: "repo", branch: "main" });
}
function observationsFor() {
  return readReclaimCandidates().candidates.map(row => ({ conversationId: row.conversationId,
    workspaceId: row.workspaceId!, taskId: row.taskId!, generation: row.generation!, assignmentEpoch: row.assignmentEpoch,
    observedAt: new Date().toISOString(), taskStatus: "idle" as const, chatStatus: "idle" as const, readbackClean: true as const }));
}
function notLoadedObservationsFor(): NotLoadedReclaimObservation[] {
  return readReclaimCandidates().candidates.map(row => {
    const observedAt = new Date().toISOString();
    return {
      conversationId: row.conversationId,
      workspaceId: row.workspaceId!, taskId: row.taskId!, generation: row.generation!, assignmentEpoch: row.assignmentEpoch,
      observedAt, taskStatus: "notLoaded" as const, chatStatus: "idle" as const, readbackClean: true as const,
      taskReadTaskId: row.taskId!, snapshotTaskId: row.taskId!, recheckTaskId: row.taskId!,
      taskReadLatestTurnId: `turn-${row.taskId}`, taskReadLatestTurnStatus: "completed" as const,
      taskReadHostId: "local", snapshotHostId: "local", snapshotStatus: "inactiveStatus" as const,
      latestTurnId: `turn-${row.taskId}`, latestTurnStatus: "completed" as const,
      taskReadAt: observedAt, snapshotReadAt: observedAt, chatReadAt: observedAt,
      recheckHostId: "local", recheckSnapshotStatus: "inactiveStatus" as const,
      recheckLatestTurnId: `turn-${row.taskId}`, recheckLatestTurnStatus: "completed" as const, recheckReadAt: observedAt,
      receiptIteration: row.iteration!, receiptMessageId: row.lastDeliveredMessageId!, receiptState: row.lastState!,
      receiptReviewHead: row.lastReviewHead,
    };
  });
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

it("accepts corroborated notLoaded evidence, archives the old owner, and boots the new owner", async () => {
  const oldRoute = await issueRouteCapability({ workspaceId, taskId: "old-owner", conversationId: "rotation-chat" });
  await attachTaskRouteCapability(workspaceId, "old-owner", oldRoute.id);
  const observed = notLoadedObservationsFor();

  const result = await claim("new-owner", workspaceId, observed);

  expect(result.task.conversationId).toBe("rotation-chat");
  expect(result.entry.assignmentEpoch).toBe(observed[0].assignmentEpoch + 1);
  expect(readTaskSession(workspaceId, "old-owner")).toBeNull();
  expect(JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8")).assignmentHistory.at(-1)).toMatchObject({
    reason: "pool_reclaimed", taskId: "old-owner", fromWorkspaceId: workspaceId,
  });
  await expect(resolveRouteCapability(oldRoute.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
  await boot("new-owner");
  expect(readTaskSession(workspaceId, "new-owner")).toMatchObject({ verificationState: "ready", channelState: "ready" });
});

it.each(["lease", "pending"])("rejects a candidate that acquired %s after observation without writes", async kind => {
  const observed = notLoadedObservationsFor();
  if (kind === "lease") await resumeTaskSession(workspaceId, "old-owner");
  else await beginTaskSend(workspaceId, "old-owner", newMessageId(), 1);
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(claim("new-owner", workspaceId, observed)).rejects.toThrow("POOL_BUSY");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  expect(readReclaimCandidates().candidates).toHaveLength(0);
  expect(readReclaimCandidates().excluded[0].exclusionReason).toBe(kind === "lease" ? "active_lease" : "pending_or_degraded");
});

it("permits only one claimant for a shared observation", async () => {
  const observed = notLoadedObservationsFor();
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
    await expect(claim("new", workspaceId, kind === "missing" ? undefined : observed)).rejects.toThrow(
      kind === "missing" ? "POOL_OBSERVATION_REQUIRED" : ["expired", "future"].includes(kind) ? "RECLAIM_OBSERVATION_EXPIRED" : "RECLAIM_CANDIDATE_CHANGED");
    expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  });

it("rejects incomplete notLoaded evidence without treating it as idle", async () => {
  const [valid] = observationsFor();
  const incomplete = { ...valid, taskStatus: "notLoaded" };
  expect(() => validateReclaimObservations([incomplete])).toThrow("RECLAIM_OBSERVATIONS_INVALID");
});

it.each(["host", "unfinished-turn", "changed-turn", "receipt", "read-order", "expired-read", "future-read"])(
  "rejects invalid notLoaded %s evidence without modifying the ledger", async kind => {
    const [observed] = notLoadedObservationsFor();
    if (kind === "host") observed.recheckHostId = "other-host";
    if (kind === "unfinished-turn") observed.latestTurnStatus = "active" as never;
    if (kind === "changed-turn") observed.recheckLatestTurnId = "other-turn";
    if (kind === "receipt") observed.receiptMessageId = "wrong-message";
    if (kind === "read-order") observed.chatReadAt = new Date(Date.parse(observed.snapshotReadAt) - 1).toISOString();
    if (kind === "expired-read") observed.taskReadAt = new Date(Date.now() - 61_000).toISOString();
    if (kind === "future-read") observed.recheckReadAt = new Date(Date.now() + 61_000).toISOString();
    const before = fs.readFileSync(sessionLedgerFile(), "utf8");
    if (["host", "unfinished-turn", "changed-turn"].includes(kind)) {
      expect(() => validateReclaimObservations([observed])).toThrow("RECLAIM_OBSERVATIONS_INVALID");
    } else {
      await expect(claim("new-owner", workspaceId, [observed])).rejects.toThrow(kind === "receipt" ? "RECLAIM_CANDIDATE_CHANGED" :
        kind === "read-order" ? "POOL_OBSERVATION_REQUIRED" : "RECLAIM_OBSERVATION_EXPIRED");
    }
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
  fs.writeFileSync(file, JSON.stringify(notLoadedObservationsFor()));
  const claimed = cli(...args, "--reclaim-observations-file", file);
  expect(claimed.status, claimed.stderr).toBe(0);
  expect(JSON.parse(claimed.stdout)).toMatchObject({ task: { taskId: "cli-owner", conversationId: "rotation-chat" }, nextAction: "send_boot_prompt" });
  expect(readTaskSession(workspaceId, "old-owner")).toBeNull();
});

async function failedRequester(target = workspaceId, withLease = false): Promise<BoundRecoveryObservation> {
  await importStandbyConversation({ conversationId: "requester-chat", projectId: "g-p-rotation",
    markerText: "C2C_STANDBY_READY", markerMessageId: "requester-marker", markerRole: "user" });
  await claim("requester", target); await boot("requester", target);
  const lease = withLease ? await resumeTaskSession(target, "requester") : undefined;
  const routingCheckedAt = new Date().toISOString();
  const messageId = newMessageId();
  await beginTaskSend(target, "requester", messageId, 1, { useId: lease?.useId });
  const failed = await failTaskDelivery(target, "requester", messageId, "host_rejected", "correct ChatGPT routing rejected");
  const observedAt = new Date().toISOString();
  return { taskId: "requester", workspaceId: target, conversationId: "requester-chat", generation: failed.generation,
    failureCheckedAt: failed.lastDeliveryCheckedAt!, routingCheckedAt, chatReadAt: observedAt,
    observedAt, hostRoutingChecked: true, routingMode: "conversation_id_only", chatStatus: "idle", readbackClean: true,
    receiptIteration: failed.iteration, receiptMessageId: failed.lastDeliveredMessageId ?? null,
    receiptState: failed.lastState ?? null, receiptReviewHead: failed.lastReviewHead, reason: "host_rejected" };
}

const recover = (recoveryObservation: BoundRecoveryObservation, reclaimObservations = notLoadedObservationsFor()) =>
  claimStandbyConversation({ workspaceId: recoveryObservation.workspaceId, taskId: "requester", connectorName: "C2C",
    workspaceName: "repo", branch: "main", recoveryObservation, reclaimObservations });

it.each([true, false])("recovers a failed binding atomically with same workspace=%s while keeping fixed inventory", async same => {
  const otherRoot = path.join(state, "other-workspace");
  fs.mkdirSync(otherRoot); makeGitRepo(otherRoot);
  const router = await createWorkspaceRouter(workspace);
  const target = same ? workspaceId : (await router.register(otherRoot)).workspaceId;
  const evidence = await failedRequester(target);
  const previous = readTaskSession(target, "requester")!;
  const requesterRoute = await issueRouteCapability({ workspaceId: target, taskId: "requester", conversationId: "requester-chat" });
  await attachTaskRouteCapability(target, "requester", requesterRoute.id);
  const oldRoute = await issueRouteCapability({ workspaceId, taskId: "old-owner", conversationId: "rotation-chat" });
  await attachTaskRouteCapability(workspaceId, "old-owner", oldRoute.id);
  const before = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  const result = await recover(evidence);
  const after = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  expect(result.task).toMatchObject({ taskId: "requester", conversationId: "rotation-chat", generation: previous.generation + 1, verificationState: "pending" });
  expect(after.pool.entries).toHaveLength(before.pool.entries.length);
  expect(after.pool.entries.filter((entry: {status: string}) => entry.status !== "retired")).toHaveLength(2);
  expect(after.pool.entries.find((entry: {conversationId: string}) => entry.conversationId === "requester-chat")).toMatchObject({ status: "quarantined" });
  expect(readTaskSession(workspaceId, "old-owner")).toBeNull();
  expect(new Set(after.registries.map((registry: {workspaceId: string}) => registry.workspaceId)).size).toBe(after.registries.length);
  expect(after.assignmentHistory).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: "pool_reclaimed", taskId: "old-owner", toTaskId: "requester", assignmentEpoch: result.entry.assignmentEpoch }),
    expect.objectContaining({ reason: "binding_recovered", taskId: "requester", snapshot: expect.objectContaining({ lastDeliveredMessageId: previous.lastDeliveredMessageId }) }),
  ]));
  await expect(resolveRouteCapability(requesterRoute.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
  await expect(resolveRouteCapability(oldRoute.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");
  await boot("requester", target);
  expect(readTaskSession(target, "requester")?.verificationState).toBe("ready");
});

it.each(["generation", "task", "workspace", "conversation", "failure", "expired", "routing", "lease"])(
  "rejects recovery with %s mismatch and preserves all bindings and receipts", async kind => {
    const evidence = await failedRequester(workspaceId, kind === "lease");
    if (kind === "generation") evidence.generation++;
    if (kind === "task") evidence.taskId = "someone-else";
    if (kind === "workspace") evidence.workspaceId = "wrong";
    if (kind === "conversation") evidence.conversationId = "wrong";
    if (kind === "failure") evidence.failureCheckedAt = new Date(0).toISOString();
    if (kind === "expired") evidence.chatReadAt = new Date(Date.now() - 61_000).toISOString();
    if (kind === "routing") evidence.hostRoutingChecked = false as never;
    const before = fs.readFileSync(sessionLedgerFile(), "utf8");
    await expect(recover(evidence)).rejects.toThrow();
    expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  });

it("keeps a healthy binding instead of rotating on plain claim", async () => {
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  expect((await claim("old-owner", workspaceId, notLoadedObservationsFor())).reused).toBe(true);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("fences two simultaneous recoveries to one replacement generation", async () => {
  const evidence = await failedRequester();
  const observations = notLoadedObservationsFor();
  const results = await Promise.allSettled([recover(evidence, observations), recover(evidence, observations)]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(readTaskSession(workspaceId, "requester")?.generation).toBe(2);
});

it.each(["taskReadTaskId", "snapshotTaskId", "recheckTaskId", "taskReadLatestTurnId"])(
  "rejects notLoaded identity mismatch in %s", field => {
    const [evidence] = notLoadedObservationsFor();
    expect(() => validateReclaimObservations([{ ...evidence, [field]: "different" }])).toThrow("RECLAIM_OBSERVATIONS_INVALID");
  });

it("accepts CLI failed-binding recovery from two UTF-8 evidence files", async () => {
  const recovery = await failedRequester();
  const candidateFile = path.join(state, "candidate.json"), recoveryFile = path.join(state, "recovery.json");
  fs.writeFileSync(candidateFile, JSON.stringify(notLoadedObservationsFor()));
  fs.writeFileSync(recoveryFile, JSON.stringify(recovery));
  const result = cli("claim", "-w", workspace, "--task-id", "requester", "--reclaim-observations-file", candidateFile,
    "--recover-bound-file", recoveryFile, "--json");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ task: { generation: 2, conversationId: "rotation-chat" }, nextAction: "send_boot_prompt" });
});

it("rotates the oldest safe Chat in ten existing entries, skips busy owners, and carries its own lease", async () => {
  for (let index = 0; index < 8; index++) {
    await importStandbyConversation({ conversationId: `extra-${index}`, projectId: "g-p-rotation",
      markerText: "C2C_STANDBY_READY", markerMessageId: `marker-${index}`, markerRole: "user" });
    await claim(`owner-${index}`); await boot(`owner-${index}`);
  }
  await resumeTaskSession(workspaceId, "old-owner");
  const evidence = await failedRequester(workspaceId, true);
  const current = readTaskSession(workspaceId, "requester")!;
  evidence.useId = current.activeUse!.useId;
  const observed = notLoadedObservationsFor().reverse();
  const before = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  const result = await recover(evidence, observed);
  const after = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  expect(result.task.conversationId).toBe("extra-0");
  expect(result.task.activeUse).toEqual(current.activeUse);
  expect(after.pool.entries).toHaveLength(10);
  expect(after.pool.entries.map((entry: {id: string}) => entry.id)).toEqual(before.pool.entries.map((entry: {id: string}) => entry.id));
  for (const original of before.registries[0].tasks.filter((task: {taskId: string}) => !["requester", "owner-0"].includes(task.taskId))) {
    expect(readTaskSession(workspaceId, original.taskId)).toEqual(original);
  }
  await boot("requester");
});

it.each(["old-rejection", "receipt", "future", "fake-lease", "pending", "candidate-lease", "candidate-pending"])(
  "preserves all state for failed recovery after %s", async kind => {
    const evidence = await failedRequester();
    const observed = notLoadedObservationsFor();
    if (kind === "old-rejection") evidence.routingCheckedAt = new Date(Date.parse(evidence.failureCheckedAt) + 1).toISOString();
    if (kind === "receipt") evidence.receiptMessageId = "wrong";
    if (kind === "future") evidence.observedAt = new Date(Date.now() + 60_000).toISOString();
    if (kind === "fake-lease") evidence.useId = "c2c_use_00000000-0000-4000-8000-000000000000";
    if (kind === "pending") await beginTaskSend(workspaceId, "requester", newMessageId(), 1, { probe: true });
    if (kind === "candidate-lease") await resumeTaskSession(workspaceId, "old-owner");
    if (kind === "candidate-pending") await beginTaskSend(workspaceId, "old-owner", newMessageId(), 1);
    const before = fs.readFileSync(sessionLedgerFile(), "utf8");
    await expect(recover(evidence, observed)).rejects.toThrow();
    expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  });
