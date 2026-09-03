import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoLegacyWindowsWorkspaceState,
  CHATGPT_WINDOWS_SANDBOX_CAPABILITY_SID,
  CODEX_WINDOWS_SANDBOX_CAPABILITY_SID,
  cleanupLegacyWindowsWorkspaceArtifacts,
  hasLegacyWindowsWriteRights,
  isAllowedLegacyWindowsPackageProjection,
  isTrustedLegacyWindowsAclOwner,
  isTrustedLegacyWindowsAclWriter,
  LegacyWindowsStateError,
  validateLegacyWindowsStateForCleanup,
} from "../src/config/legacy-state.js";
import { revokeLegacyWindowsWorkspaceAccess } from "../src/auth/revoke.js";
import { acquireWorkspaceLifecycleLock } from "../src/process/workspace-lock.js";
import {
  getProcessGeneration,
  requireCurrentProcessGeneration,
} from "../src/process/process-identity.js";
import { resolveWorkspaceIdentity, Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const originalStateDir = process.env.C2C_STATE_DIR;
const originalLocalAppData = process.env.LOCALAPPDATA;
const roots: string[] = [];

function temp(name: string): string {
  // GitHub-hosted Windows grants broad write access under the checkout root.
  // Use the account's private temp tree so ACL tests model real per-user state.
  const dir =
    process.platform === "win32"
      ? fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`)))
      : makeTmpDir(name);
  roots.push(dir);
  return dir;
}

async function cleanupUnderLegacyLock(
  workspaceId: string,
  localAppData: string
): Promise<{ legacyRoot: string; removed: number }> {
  const previousStateDir = process.env.C2C_STATE_DIR;
  const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
  process.env.C2C_STATE_DIR = legacyRoot;
  const held = await acquireWorkspaceLifecycleLock(workspaceId, {
    timeoutMs: 1000,
    pollMs: 5,
  });
  try {
    return cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
      platform: "win32",
      localAppData,
      activeLifecycleNonce: held.nonce,
    });
  } finally {
    held.release();
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
  }
}

beforeEach(() => {
  delete process.env.C2C_STATE_DIR;
});

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = originalLocalAppData;
});

describe("legacy Windows state guard", () => {
  it("allows only exact Codex and ChatGPT LocalAppData package projections", () => {
    const root = "C:\\Users\\TARGET\\AppData\\Local\\codex-with-chatgpt";
    const requested = `${root}\\endpoints`;
    expect(
      isAllowedLegacyWindowsPackageProjection(
        requested,
        "C:\\Users\\TARGET\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\codex-with-chatgpt\\endpoints",
        root
      )
    ).toBe(true);
    expect(
      isAllowedLegacyWindowsPackageProjection(
        requested,
        "C:\\Users\\TARGET\\AppData\\Local\\Packages\\OpenAI.ChatGPT-Desktop_2p2nqsd0c76g0\\LocalCache\\Local\\codex-with-chatgpt\\endpoints",
        root
      )
    ).toBe(true);
    for (const real of [
      "C:\\Users\\TARGET\\AppData\\Local\\Packages\\OpenAI.Codex_OTHER\\LocalCache\\Local\\codex-with-chatgpt\\endpoints",
      "C:\\Users\\TARGET\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\other-app\\endpoints",
      "C:\\Users\\TARGET\\AppData\\Local\\Packages\\OpenAI.Codex_2p2nqsd0c76g0\\LocalCache\\Local\\codex-with-chatgpt\\auth",
      "C:\\Users\\TARGET\\AppData\\Local\\outside\\endpoints",
    ]) {
      expect(isAllowedLegacyWindowsPackageProjection(requested, real, root)).toBe(false);
    }
  });

  it.each(["\\\\HOST\\share", "\\\\?\\C:\\Temp", "\\root-relative"])(
    "rejects unsafe legacy root %s before filesystem IO",
    (localAppData) => {
      const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(() => {
        throw new Error("unexpected filesystem IO");
      });
      const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw new Error("unexpected filesystem IO");
      });
      try {
        expect(() =>
          assertNoLegacyWindowsWorkspaceState("abc123def456", {
            platform: "win32",
            localAppData,
          })
        ).toThrow(/local drive|unsafe Windows path/is);
        expect(lstat).not.toHaveBeenCalled();
        expect(readdir).not.toHaveBeenCalled();
      } finally {
        lstat.mockRestore();
        readdir.mockRestore();
      }
    }
  );

  it("allows only trusted ACL owners and writers", () => {
    const currentSid = "S-1-5-21-1-2-3-1001";
    expect(isTrustedLegacyWindowsAclOwner(currentSid, currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclOwner("S-1-5-18", currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclOwner("S-1-5-32-544", currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclOwner(CODEX_WINDOWS_SANDBOX_CAPABILITY_SID, currentSid)).toBe(
      false
    );
    expect(isTrustedLegacyWindowsAclOwner(CHATGPT_WINDOWS_SANDBOX_CAPABILITY_SID, currentSid)).toBe(
      false
    );
    expect(isTrustedLegacyWindowsAclOwner("S-1-5-21-9-8-7-1002", currentSid)).toBe(false);
    expect(isTrustedLegacyWindowsAclWriter(currentSid, currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclWriter("S-1-5-18", currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclWriter("S-1-5-32-544", currentSid)).toBe(true);
    expect(isTrustedLegacyWindowsAclWriter(CODEX_WINDOWS_SANDBOX_CAPABILITY_SID, currentSid)).toBe(
      true
    );
    expect(
      isTrustedLegacyWindowsAclWriter(CHATGPT_WINDOWS_SANDBOX_CAPABILITY_SID, currentSid)
    ).toBe(true);
    expect(
      isTrustedLegacyWindowsAclWriter(
        "S-1-15-3-1024-1-2-3-4-5-6-7-8",
        currentSid
      )
    ).toBe(false);
    expect(
      isTrustedLegacyWindowsAclWriter(
        "S-1-15-3-2569235138-1347164924-3176874416-3980197141-1442029411-569003742-1232801008",
        currentSid
      )
    ).toBe(false);
  });

  it("classifies atomic and generic write rights while preserving generic read/execute", () => {
    expect(hasLegacyWindowsWriteRights(131241)).toBe(false); // ReadAndExecute
    expect(hasLegacyWindowsWriteRights(2)).toBe(true); // CreateFiles / WriteData
    expect(hasLegacyWindowsWriteRights(64)).toBe(true); // DeleteSubdirectoriesAndFiles
    expect(hasLegacyWindowsWriteRights(197055)).toBe(true); // Modify
    expect(hasLegacyWindowsWriteRights(2032127)).toBe(true); // FullControl
    expect(hasLegacyWindowsWriteRights(0x10000000)).toBe(true); // GenericAll
    expect(hasLegacyWindowsWriteRights(0x40000000)).toBe(true); // GenericWrite
    expect(hasLegacyWindowsWriteRights(0x80000000)).toBe(false); // GenericRead
    expect(hasLegacyWindowsWriteRights(0x20000000)).toBe(false); // GenericExecute
  });

  it("performs a finite read-only cleanup preflight", () => {
    const localAppData = temp("legacy-preflight");
    const workspaceId = "abc123def456";

    const inspection = validateLegacyWindowsStateForCleanup(workspaceId, {
      platform: "win32",
      localAppData,
    });

    expect(inspection.legacyRoot).toBe(path.join(localAppData, "codex-with-chatgpt"));
    expect(inspection.artifacts).toEqual([]);
    expect(inspection.inspectionFailures).toEqual([]);
  });

  it("fails closed when an old Bridge for the workspace may still be live", () => {
    const localAppData = temp("legacy-localappdata");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";
    write(
      legacyRoot,
      `runtime/${workspaceId}.json`,
      JSON.stringify({ workspaceId, pid: process.pid, processGeneration: null })
    );

    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/legacy Windows state.*legacy-cleanup/is);
  });

  it("blocks a dead-looking packaged runtime because it may mask a live host view", () => {
    const localAppData = temp("legacy-dead-runtime");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";
    write(
      legacyRoot,
      `runtime/${workspaceId}.json`,
      JSON.stringify({ workspaceId, pid: 1234, processGeneration: "old-generation" })
    );

    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/regular Windows Terminal first.*inside packaged Codex or ChatGPT/is);
  });

  it("blocks a legacy credential even when no runtime record exists", () => {
    const localAppData = temp("legacy-credential");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";

    write(legacyRoot, `transports/${workspaceId}.token`, "redacted-test-fixture\n");
    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/legacy Windows state/is);
  });

  it("blocks and clears legacy transport, tunnel, and endpoint metadata", async () => {
    const localAppData = temp("legacy-connection-metadata");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";
    const files = [
      write(legacyRoot, `transports/${workspaceId}.json`, '{"mode":"openai"}\n'),
      write(legacyRoot, `tunnels/${workspaceId}.json`, '{"preference":"unset"}\n'),
      write(legacyRoot, `endpoints/${workspaceId}.json`, '{"mcpUrl":null}\n'),
    ];

    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/legacy Windows state/is);

    const result = await cleanupUnderLegacyLock(workspaceId, localAppData);
    expect(result.removed).toBe(3);
    expect(files.every((file) => !fs.existsSync(file))).toBe(true);
  });

  it("does not let an explicit legacy state override bypass normal workspace commands", () => {
    const localAppData = temp("legacy-explicit-override");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";
    write(
      legacyRoot,
      `transports/${workspaceId}.token`,
      "redacted-test-fixture\n"
    );
    process.env.C2C_STATE_DIR = legacyRoot;

    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/legacy Windows state/is);
  });

  it("uses the dedicated cleanup transaction for the legacy state view", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-cleanup-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-cleanup-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(legacyRoot, `auth/${workspaceId}.json`, '{"clients":[],"tokens":[]}\n');

    const result = await revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
      listRuntimeStates: () => [],
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      cancelPendingStarts: () => 0,
      listPendingStarts: () => [],
      revokeTunnelToken: () => false,
    });

    expect(result.alreadyClean).toBe(false);
    expect(result.removedArtifacts).toBe(1);
    expect(fs.existsSync(credential)).toBe(false);
    expect(process.env.C2C_STATE_DIR).toBeUndefined();
  });

  it("deletes no direct artifact when the claimed cleanup lock is not held", () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-fake-lock-localappdata");
    const workspaceId = "abc123def456";
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(
      legacyRoot,
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    process.env.C2C_STATE_DIR = legacyRoot;
    const mkdir = vi.spyOn(fs, "mkdirSync");

    try {
      expect(() =>
        cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
          platform: "win32",
          localAppData,
          activeLifecycleNonce: "fake-cleanup-lock",
        })
      ).toThrow(/lost|does not hold.*lifecycle lock/is);
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      mkdir.mockRestore();
    }
    expect(fs.existsSync(credential)).toBe(true);
  });

  it("deletes no direct artifact when the held ticket content nonce is replaced", async () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-replaced-lock-localappdata");
    const workspaceId = "abc123def456";
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(
      legacyRoot,
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    process.env.C2C_STATE_DIR = legacyRoot;
    const held = await acquireWorkspaceLifecycleLock(workspaceId, {
      timeoutMs: 1000,
      pollMs: 5,
    });
    const ownTicket = path.join(
      legacyRoot,
      "locks",
      `${workspaceId}.lifecycle.${held.nonce}.ticket.json`
    );
    const descriptor = JSON.parse(fs.readFileSync(ownTicket, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(
      ownTicket,
      JSON.stringify({ ...descriptor, nonce: "different-ticket-nonce" }),
      { mode: 0o600 }
    );

    try {
      expect(() =>
        cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
          platform: "win32",
          localAppData,
          activeLifecycleNonce: held.nonce,
        })
      ).toThrow(/manual inspection|lost.*lifecycle lock/is);
      expect(fs.existsSync(credential)).toBe(true);
    } finally {
      held.release();
    }
  });

  it("uses the production stop helper without re-entering the normal workspace guard", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-production-stop-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-production-stop-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const startedAt = new Date().toISOString();
    const child = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
const http = require("node:http");
const metadata = {
  service: "c2c-bridge",
  workspaceId: process.env.C2C_TEST_WORKSPACE_ID,
  workspaceRoot: process.env.C2C_TEST_WORKSPACE_ROOT,
  pid: process.pid,
  startedAt: process.env.C2C_TEST_STARTED_AT,
};
const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.headers.authorization !== "Bearer TEST_ADMIN_TOKEN") {
    response.statusCode = 401;
    response.end(JSON.stringify({ message: "unauthorized" }));
    return;
  }
  if (request.method === "GET" && request.url === "/admin/info") {
    response.end(JSON.stringify({ ...metadata, port: server.address().port }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/revoke-all") {
    response.end(JSON.stringify({ revoked: 0 }));
    return;
  }
  if (request.method === "POST" && request.url === "/admin/shutdown") {
    response.end(JSON.stringify({ shuttingDown: true }), () => {
      server.close(() => process.exit(0));
    });
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: "not found" }));
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
setInterval(() => {}, 1000).unref();
`,
      ],
      {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
        env: {
          ...process.env,
          C2C_TEST_WORKSPACE_ID: workspaceId,
          C2C_TEST_WORKSPACE_ROOT: workspaceRoot,
          C2C_TEST_STARTED_AT: startedAt,
        },
      }
    );

    try {
      const port = await new Promise<number>((resolve, reject) => {
        let output = "";
        let timer: NodeJS.Timeout;
        const cleanupListeners = (): void => {
          clearTimeout(timer);
          child.stdout?.off("data", onData);
          child.off("error", onError);
          child.off("exit", onExit);
        };
        const onData = (chunk: Buffer | string): void => {
          output += String(chunk);
          const line = output.split(/\r?\n/u)[0]?.trim();
          if (/^\d+$/u.test(line)) {
            cleanupListeners();
            resolve(Number(line));
          }
        };
        const onError = (error: Error): void => {
          cleanupListeners();
          reject(error);
        };
        const onExit = (code: number | null): void => {
          cleanupListeners();
          reject(new Error(`legacy fixture exited early (${String(code)})`));
        };
        timer = setTimeout(() => {
          cleanupListeners();
          reject(new Error("Timed out waiting for the legacy fixture port"));
        }, 5000);
        child.stdout?.on("data", onData);
        child.once("error", onError);
        child.once("exit", onExit);
      });
      if (!child.pid) throw new Error("legacy fixture PID is missing");
      const runtime = write(
        legacyRoot,
        `runtime/${workspaceId}.json`,
        JSON.stringify({
          service: "c2c-bridge",
          version: "0.1.0",
          workspaceId,
          workspaceRoot,
          pid: child.pid,
          port,
          adminToken: "TEST_ADMIN_TOKEN",
          publicUrl: null,
          startedAt,
        })
      );

      let result: Awaited<ReturnType<typeof revokeLegacyWindowsWorkspaceAccess>>;
      try {
        result = await revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
          stopTimeoutMs: 250,
          maxRuntimeGenerations: 1,
        });
      } catch (error) {
        if (error instanceof AggregateError) {
          const messages = error.errors.map((entry) =>
            entry instanceof Error ? entry.message : String(entry)
          );
          throw new Error(`Production legacy cleanup failures: ${messages.join(" | ")}`, {
            cause: error,
          });
        }
        throw error;
      }

      expect(result.revocation?.bridgeStopped).toBe(true);
      expect(fs.existsSync(runtime)).toBe(false);
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(() => reject(new Error("legacy fixture did not exit")), 5000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);

  it("removes an expired generation-mismatched lifecycle ticket inside the cleanup lock", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-stale-ticket-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-stale-ticket-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const nonce = "expired-generation-ticket";
    const ticket = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.${nonce}.ticket.json`,
      JSON.stringify({
        pid: 2_147_483_647,
        processGeneration: "win32:2000-01-01T00:00:00.0000000Z",
        nonce,
        number: 1,
        choosing: false,
        acquired: true,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(ticket, old, old);

    const result = await revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
      listRuntimeStates: () => [],
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      cancelPendingStarts: () => 0,
      listPendingStarts: () => [],
      revokeTunnelToken: () => false,
    });

    expect(result.alreadyClean).toBe(false);
    expect(result.removedArtifacts).toBe(1);
    expect(fs.existsSync(ticket)).toBe(false);
    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).not.toThrow();
  });

  it("removes an expired generationless ticket only after its PID is confirmed absent", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-old-format-ticket-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-old-format-ticket-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const generationlessNonce = "generationless-ticket";
    const generationless = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.${generationlessNonce}.ticket.json`,
      JSON.stringify({
        pid: 2_147_483_647,
        processGeneration: null,
        nonce: generationlessNonce,
        number: 1,
        choosing: false,
        acquired: true,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(generationless, old, old);

    const result = await revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
      listRuntimeStates: () => [],
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      cancelPendingStarts: () => 0,
      listPendingStarts: () => [],
      revokeTunnelToken: () => false,
    });

    expect(result.alreadyClean).toBe(false);
    expect(result.removedArtifacts).toBe(1);
    expect(fs.existsSync(generationless)).toBe(false);
  });

  it("stops before revocation for expired malformed or live generationless tickets", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-ambiguous-ticket-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-ambiguous-ticket-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const liveNonce = "live-generationless-ticket";
    const live = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.${liveNonce}.ticket.json`,
      JSON.stringify({
        pid: process.pid,
        processGeneration: null,
        nonce: liveNonce,
        number: 1,
        choosing: false,
        acquired: true,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    const malformed = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.malformed-old-ticket.ticket.json`,
      "{"
    );
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(live, old, old);
    fs.utimesSync(malformed, old, old);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/manual inspection|owner may still be active/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(live)).toBe(true);
    expect(fs.existsSync(malformed)).toBe(true);
  });

  it("stops before revocation when lifecycle filename and content nonces conflict", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-conflicting-nonce-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-conflicting-nonce-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const file = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.AAAAAAAA.ticket.json`,
      JSON.stringify({
        pid: 2_147_483_647,
        processGeneration: "win32:2000-01-01T00:00:00.0000000Z",
        nonce: "BBBBBBBB",
        number: 1,
        choosing: false,
        acquired: true,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/manual inspection/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each([
    ["non-boolean choosing", { number: 1, choosing: "false", acquired: true }],
    ["non-boolean acquired", { number: 1, choosing: false, acquired: "yes" }],
    ["acquired zero-number", { number: 0, choosing: false, acquired: true }],
    ["acquired choosing", { number: 1, choosing: true, acquired: true }],
  ])("stops before revocation for a stale ticket with %s", async (_label, ownership) => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp(`legacy-malformed-ownership-${String(_label)}`);
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp(`legacy-malformed-ownership-localappdata-${String(_label)}`);
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const nonce = "malformed-ownership-ticket";
    const file = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.${nonce}.ticket.json`,
      JSON.stringify({
        pid: process.pid,
        processGeneration: requireCurrentProcessGeneration(),
        nonce,
        ...ownership,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      })
    );
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/manual inspection/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each([
    ["garbage string", "garbage"],
    ["empty string", ""],
    ["number", 42],
    ["object", { fake: true }],
  ] as const)(
    "treats an invalid %s process generation as manual before revocation",
    async (label, processGeneration) => {
      if (process.platform !== "win32") return;
      const slug = label.replace(/\s+/gu, "-");
      const workspaceRoot = temp(`legacy-invalid-generation-${slug}-workspace`);
      fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
      const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
      const localAppData = temp(`legacy-invalid-generation-${slug}-localappdata`);
      process.env.LOCALAPPDATA = localAppData;
      const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
      const nonce = "invalid-generation-ticket";
      const file = write(
        legacyRoot,
        `locks/${workspaceId}.lifecycle.${nonce}.ticket.json`,
        JSON.stringify({
          pid: process.pid,
          processGeneration,
          nonce,
          number: 1,
          choosing: false,
          acquired: true,
          createdAt: new Date(Date.now() - 120_000).toISOString(),
        })
      );
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(file, old, old);
      let authStoreCalls = 0;
      let tunnelRevokeCalls = 0;

      await expect(
        revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
          authStoreFactory: () => {
            authStoreCalls += 1;
            return { revokeAll: () => 0 };
          },
          revokeTunnelToken: () => {
            tunnelRevokeCalls += 1;
            return false;
          },
        })
      ).rejects.toThrow(/manual inspection/is);

      expect(authStoreCalls).toBe(0);
      expect(tunnelRevokeCalls).toBe(0);
      expect(fs.existsSync(file)).toBe(true);
    }
  );

  it("preserves the current lifecycle ticket and a fresh waiting contender", async () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-fresh-ticket-localappdata");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const workspaceId = "abc123def456";
    process.env.C2C_STATE_DIR = legacyRoot;
    const held = await acquireWorkspaceLifecycleLock(workspaceId, {
      timeoutMs: 1000,
      pollMs: 5,
    });
    const ownTicket = path.join(
      legacyRoot,
      "locks",
      `${workspaceId}.lifecycle.${held.nonce}.ticket.json`
    );
    const contenderNonce = "fresh-waiting-ticket";
    const contender = write(
      legacyRoot,
      `locks/${workspaceId}.lifecycle.${contenderNonce}.ticket.json`,
      JSON.stringify({
        pid: 2_147_483_647,
        processGeneration: "win32:2000-01-01T00:00:00.0000000Z",
        nonce: contenderNonce,
        number: 999,
        choosing: false,
        acquired: false,
        createdAt: new Date().toISOString(),
      })
    );
    try {
      const result = cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
        platform: "win32",
        localAppData,
        activeLifecycleNonce: held.nonce,
      });
      expect(result.removed).toBe(0);
      expect(fs.existsSync(ownTicket)).toBe(true);
      expect(fs.existsSync(contender)).toBe(true);

      const malformedFresh = write(
        legacyRoot,
        `locks/${workspaceId}.lifecycle.malformed-fresh-ticket.ticket.json`,
        "{"
      );
      expect(() =>
        cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
          platform: "win32",
          localAppData,
          activeLifecycleNonce: held.nonce,
        })
      ).toThrow(/manual inspection|lost (?:its selected |its )?workspace lifecycle lock/is);
      expect(fs.existsSync(malformedFresh)).toBe(true);
    } finally {
      held.release();
    }
  });

  it("validates an opened lifecycle ticket identity before reading its descriptor", () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-ticket-open-order-localappdata");
    const workspaceId = "abc123def456";
    const nonce = "identity-order-ticket";
    write(
      path.join(localAppData, "codex-with-chatgpt"),
      `locks/${workspaceId}.lifecycle.${nonce}.ticket.json`,
      JSON.stringify({
        pid: process.pid,
        processGeneration: null,
        nonce,
        number: 1,
        choosing: false,
        acquired: true,
        createdAt: new Date().toISOString(),
      })
    );
    const realFstat = fs.fstatSync.bind(fs);
    const fstat = vi.spyOn(fs, "fstatSync").mockImplementation(((descriptor, options) => {
      const stat = realFstat(descriptor, options as { bigint: true }) as fs.BigIntStats;
      return { ...stat, ino: stat.ino + 1n, isFile: () => true } as fs.BigIntStats;
    }) as typeof fs.fstatSync);
    const readFile = vi.spyOn(fs, "readFileSync");
    try {
      expect(() =>
        validateLegacyWindowsStateForCleanup(workspaceId, {
          platform: "win32",
          localAppData,
        })
      ).toThrow(/changed during cleanup preflight/is);
      expect(readFile.mock.calls.filter(([target]) => typeof target === "number")).toHaveLength(0);
    } finally {
      fstat.mockRestore();
      readFile.mockRestore();
    }
  });

  it("rejects a hard-linked artifact before revocation touches state", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-hardlink-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-hardlink-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const outside = write(temp("legacy-hardlink-outside"), "outside.json", "outside-file-must-stay\n");
    const linked = path.join(localAppData, "codex-with-chatgpt", "auth", `${workspaceId}.json`);
    fs.mkdirSync(path.dirname(linked), { recursive: true });
    fs.linkSync(outside, linked);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        listRuntimeStates: () => [],
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        cancelPendingStarts: () => 0,
        listPendingStarts: () => [],
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/hard.?link|multiple links/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-file-must-stay\n");
  });

  it("revalidates artifacts after acquiring the legacy lifecycle lock", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-locked-revalidation-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-locked-revalidation-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    write(legacyRoot, `endpoints/${workspaceId}.json`, '{"mcpUrl":null}\n');
    process.env.C2C_STATE_DIR = legacyRoot;
    const held = await acquireWorkspaceLifecycleLock(workspaceId);
    delete process.env.C2C_STATE_DIR;
    const outside = write(
      temp("legacy-locked-revalidation-outside"),
      "outside.json",
      "outside-file-must-stay\n"
    );
    const linked = path.join(legacyRoot, "auth", `${workspaceId}.json`);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;
    let released = false;

    const operation = revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
      listRuntimeStates: () => [],
      authStoreFactory: () => {
        authStoreCalls += 1;
        return { revokeAll: () => 0 };
      },
      cancelPendingStarts: () => 0,
      listPendingStarts: () => [],
      revokeTunnelToken: () => {
        tunnelRevokeCalls += 1;
        return false;
      },
    });
    try {
      const locksDir = path.join(legacyRoot, "locks");
      let contenderVisible = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const tickets = fs.readdirSync(locksDir).filter((name) =>
          name.startsWith(`${workspaceId}.lifecycle.`)
        );
        if (tickets.length >= 2) {
          contenderVisible = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(contenderVisible).toBe(true);
      fs.mkdirSync(path.dirname(linked), { recursive: true });
      fs.linkSync(outside, linked);
      held.release();
      released = true;
      await expect(operation).rejects.toThrow(/hard.?link|multiple links/is);
    } finally {
      if (!released) held.release();
    }

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-file-must-stay\n");
  });

  it("revalidates own-ticket nonce after legacy lock acquisition and before revocation", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-own-ticket-revalidation-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-own-ticket-revalidation-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(
      legacyRoot,
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        afterLegacyLifecycleLockAcquired: (_id, nonce, root) => {
          const ticketFile = path.join(
            root,
            "locks",
            `${workspaceId}.lifecycle.${nonce}.ticket.json`
          );
          const ticket = JSON.parse(fs.readFileSync(ticketFile, "utf8")) as Record<string, unknown>;
          fs.writeFileSync(
            ticketFile,
            JSON.stringify({ ...ticket, nonce: "different-ticket-nonce" }),
            { mode: 0o600 }
          );
        },
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/manual inspection|lost.*lifecycle lock/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(credential)).toBe(true);
  });

  it("rejects a legacy lock rebound to another live owner before revocation", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-rebound-owner-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-rebound-owner-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(
      legacyRoot,
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (!child.pid) throw new Error("legacy owner fixture PID is missing");
    let generation: string | null = null;
    for (let attempt = 0; attempt < 20 && !generation; attempt += 1) {
      generation = getProcessGeneration(child.pid);
      if (!generation) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (!generation) {
      child.kill("SIGKILL");
      throw new Error("legacy owner fixture generation is missing");
    }
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    try {
      await expect(
        revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
          afterLegacyLifecycleLockAcquired: (_id, nonce, root) => {
            const ticketFile = path.join(
              root,
              "locks",
              `${workspaceId}.lifecycle.${nonce}.ticket.json`
            );
            const ticket = JSON.parse(fs.readFileSync(ticketFile, "utf8")) as Record<string, unknown>;
            fs.writeFileSync(
              ticketFile,
              JSON.stringify({ ...ticket, pid: child.pid, processGeneration: generation }),
              { mode: 0o600 }
            );
          },
          authStoreFactory: () => {
            authStoreCalls += 1;
            return { revokeAll: () => 0 };
          },
          revokeTunnelToken: () => {
            tunnelRevokeCalls += 1;
            return false;
          },
        })
      ).rejects.toThrow(/lost.*lifecycle lock/is);
    } finally {
      child.kill("SIGKILL");
    }

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(credential)).toBe(true);
  });

  it("rejects a fresh contender whose filename and content nonces differ before revocation", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-fresh-contender-revalidation-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-fresh-contender-revalidation-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const credential = write(
      legacyRoot,
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    let contender = "";
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        afterLegacyLifecycleLockAcquired: (_id, nonce, root) => {
          const ownTicket = path.join(
            root,
            "locks",
            `${workspaceId}.lifecycle.${nonce}.ticket.json`
          );
          contender = write(
            root,
            `locks/${workspaceId}.lifecycle.fresh-cloned-ticket.ticket.json`,
            fs.readFileSync(ownTicket, "utf8")
          );
        },
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/manual inspection|lost.*lifecycle lock/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.existsSync(credential)).toBe(true);
    expect(fs.existsSync(contender)).toBe(true);
  });

  it("rejects an untrusted writable leaf ACL before revocation", async () => {
    if (process.platform !== "win32") return;
    const workspaceRoot = temp("legacy-leaf-acl-workspace");
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}\n");
    const workspaceId = resolveWorkspaceIdentity(workspaceRoot).id;
    const localAppData = temp("legacy-leaf-acl-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    const credential = write(
      path.join(localAppData, "codex-with-chatgpt"),
      `auth/${workspaceId}.json`,
      '{"clients":[],"tokens":[]}\n'
    );
    const grant = spawnSync("icacls.exe", [credential, "/grant", "*S-1-1-0:(W)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(grant.status).toBe(0);
    let authStoreCalls = 0;
    let tunnelRevokeCalls = 0;

    await expect(
      revokeLegacyWindowsWorkspaceAccess(workspaceRoot, {
        listRuntimeStates: () => [],
        authStoreFactory: () => {
          authStoreCalls += 1;
          return { revokeAll: () => 0 };
        },
        cancelPendingStarts: () => 0,
        listPendingStarts: () => [],
        revokeTunnelToken: () => {
          tunnelRevokeCalls += 1;
          return false;
        },
      })
    ).rejects.toThrow(/ACL grants write access|untrusted principal/is);

    expect(authStoreCalls).toBe(0);
    expect(tunnelRevokeCalls).toBe(0);
    expect(fs.readFileSync(credential, "utf8")).toContain('"clients"');
  });

  it("allows an untrusted read-only leaf ACL", () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-readonly-leaf-acl");
    const workspaceId = "abc123def456";
    const metadata = write(
      path.join(localAppData, "codex-with-chatgpt"),
      `endpoints/${workspaceId}.json`,
      '{"mcpUrl":null}\n'
    );
    const grant = spawnSync("icacls.exe", [metadata, "/grant", "*S-1-1-0:(R)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(grant.status).toBe(0);

    expect(() =>
      validateLegacyWindowsStateForCleanup(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).not.toThrow();
  });

  it("checks every ACL across a large set of long generation paths", () => {
    if (process.platform !== "win32") return;
    const localAppData = temp("legacy-中文-large-acl-input-localappdata");
    const workspaceId = "abc123def456";
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const generationDir = path.join(legacyRoot, "runtime-generations", workspaceId);
    const files = Array.from({ length: 512 }, (_, index) =>
      write(
        generationDir,
        `${String(index).padStart(3, "0")}-${"g".repeat(64)}.json`,
        "{}\n"
      )
    );

    expect(() =>
      validateLegacyWindowsStateForCleanup(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).not.toThrow();

    const last = files.at(-1);
    if (!last) throw new Error("large ACL fixture is empty");
    const grant = spawnSync("icacls.exe", [last, "/grant", "*S-1-1-0:(W)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    expect(grant.status).toBe(0);
    expect(() =>
      validateLegacyWindowsStateForCleanup(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/ACL grants write access to an untrusted principal/is);
  }, 20_000);

  it("reports a shared-directory inspection failure without calling it removable workspace state", () => {
    const localAppData = temp("legacy-shared-probe-failure");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const sharedPendingPath = write(legacyRoot, "pending-starts", "not a directory\n");
    const workspaceId = "abc123def456";

    let caught: unknown;
    try {
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LegacyWindowsStateError);
    const legacyError = caught as LegacyWindowsStateError;
    expect(legacyError.artifacts).not.toContain(sharedPendingPath);
    expect(legacyError.inspectionFailures).toContain(sharedPendingPath);
    expect(legacyError.message).toMatch(/repair access or restore.*do not delete shared directories/is);
  });

  it("does not let a custom process state override hide legacy default state", () => {
    const localAppData = temp("legacy-process-override");
    const workspaceId = "abc123def456";
    write(
      path.join(localAppData, "codex-with-chatgpt"),
      `transports/${workspaceId}.token`,
      "redacted-test-fixture\n"
    );
    process.env.C2C_STATE_DIR = temp("legacy-active-process-override");

    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData,
      })
    ).toThrow(/legacy Windows state/is);
  });

  it("cleans host and private views in sequence while preserving other workspaces", async () => {
    const hostLocalAppData = temp("legacy-host-view");
    const privateLocalAppData = temp("legacy-private-view");
    const workspaceId = "abc123def456";
    const otherWorkspaceId = "999999999999";

    for (const localAppData of [hostLocalAppData, privateLocalAppData]) {
      const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
      write(legacyRoot, `runtime/${workspaceId}.json`, "{}\n");
      write(legacyRoot, `runtime-generations/${workspaceId}/generation.json`, "{}\n");
      write(legacyRoot, `auth/${workspaceId}.json`, '{"clients":[],"tokens":[]}\n');
      write(legacyRoot, `auth/${otherWorkspaceId}.json`, '{"clients":[],"tokens":[]}\n');
    }

    const hostCleanup = await cleanupUnderLegacyLock(workspaceId, hostLocalAppData);
    expect(hostCleanup.removed).toBe(3);
    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData: hostLocalAppData,
      })
    ).not.toThrow();
    expect(() =>
      assertNoLegacyWindowsWorkspaceState(workspaceId, {
        platform: "win32",
        localAppData: privateLocalAppData,
      })
    ).toThrow(/legacy Windows state/is);

    const privateCleanup = await cleanupUnderLegacyLock(workspaceId, privateLocalAppData);
    expect(privateCleanup.removed).toBe(3);
    for (const localAppData of [hostLocalAppData, privateLocalAppData]) {
      expect(() =>
        assertNoLegacyWindowsWorkspaceState(workspaceId, {
          platform: "win32",
          localAppData,
        })
      ).not.toThrow();
      expect(
        fs.existsSync(
          path.join(localAppData, "codex-with-chatgpt", "auth", `${otherWorkspaceId}.json`)
        )
      ).toBe(true);
    }
  });

  it("rejects a junction ancestor and preserves the file outside the legacy root", () => {
    const localAppData = temp("legacy-junction-root");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const outside = temp("legacy-junction-outside");
    const workspaceId = "abc123def456";
    const outsideAuth = write(outside, `${workspaceId}.json`, "outside-file-must-stay\n");
    fs.mkdirSync(legacyRoot, { recursive: true });
    fs.symlinkSync(outside, path.join(legacyRoot, "auth"), process.platform === "win32" ? "junction" : "dir");

    const lstat = vi.spyOn(fs, "lstatSync");
    const readdir = vi.spyOn(fs, "readdirSync");
    try {
      expect(() =>
        validateLegacyWindowsStateForCleanup(workspaceId, {
          platform: "win32",
          localAppData,
        })
      ).toThrow(/symbolic link|reparse|real path/is);
      expect(lstat.mock.calls.some(([file]) => path.resolve(String(file)) === path.resolve(path.join(legacyRoot, "auth", `${workspaceId}.json`)))).toBe(false);
      expect(readdir.mock.calls.some(([dir]) => path.resolve(String(dir)) === path.resolve(path.join(legacyRoot, "auth")))).toBe(false);
    } finally {
      lstat.mockRestore();
      readdir.mockRestore();
    }
    expect(fs.readFileSync(outsideAuth, "utf8")).toBe("outside-file-must-stay\n");
  });

  it("rejects a junction legacy root before touching any descendant", () => {
    const localAppData = temp("legacy-root-junction-parent");
    const legacyRoot = path.join(localAppData, "codex-with-chatgpt");
    const outside = temp("legacy-root-junction-outside");
    const workspaceId = "abc123def456";
    const outsideAuth = write(outside, `auth/${workspaceId}.json`, "outside-root-file-must-stay\n");
    fs.symlinkSync(outside, legacyRoot, process.platform === "win32" ? "junction" : "dir");

    const lstat = vi.spyOn(fs, "lstatSync");
    const readdir = vi.spyOn(fs, "readdirSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    try {
      expect(() =>
        cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
          platform: "win32",
          localAppData,
          activeLifecycleNonce: "fake-cleanup-lock",
        })
      ).toThrow(/symbolic link|reparse|real path/is);
      expect(
        lstat.mock.calls.some(
          ([file]) => path.resolve(String(file)) !== path.resolve(legacyRoot)
        )
      ).toBe(false);
      expect(readdir).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
    } finally {
      lstat.mockRestore();
      readdir.mockRestore();
      mkdir.mockRestore();
    }
    expect(fs.readFileSync(outsideAuth, "utf8")).toBe("outside-root-file-must-stay\n");
  });

  it("is enforced when Workspace resolves a real project", () => {
    if (process.platform !== "win32") return;
    const root = temp("legacy-workspace");
    fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    roots.push(isolateStateDir());
    const workspaceId = new Workspace(root).id;

    const localAppData = temp("legacy-workspace-localappdata");
    process.env.LOCALAPPDATA = localAppData;
    delete process.env.C2C_STATE_DIR;
    write(
      path.join(localAppData, "codex-with-chatgpt"),
      `runtime/${workspaceId}.json`,
      JSON.stringify({ workspaceId, pid: process.pid, processGeneration: null })
    );

    expect(() => new Workspace(root)).toThrow(/legacy Windows state/is);
  });
});
