import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkspaceLifecycleLockHeldBy,
  lifecycleTicketFile,
} from "../src/process/workspace-lock.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateDir: string | null = null;

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  if (stateDir) cleanup(stateDir);
  stateDir = null;
});

function writeTicket(
  workspaceId: string,
  nonce: string,
  number: number,
  acquired: boolean,
  choosing = false
): void {
  const file = lifecycleTicketFile(workspaceId, nonce);
  fs.writeFileSync(
    file,
    JSON.stringify({
      pid: process.pid,
      processGeneration: null,
      nonce,
      number,
      choosing,
      acquired,
      createdAt: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );
}

describe("lifecycle acquisition finalization", () => {
  it("does not confirm ownership while an earlier finalized ticket has not acquired yet", () => {
    stateDir = isolateStateDir();
    const workspaceId = `finalization-${process.pid}`;
    const earlier = "aaaaaaaa-earlier-ticket";
    const candidate = "zzzzzzzz-candidate-ticket";

    writeTicket(workspaceId, earlier, 1, false, false);
    writeTicket(workspaceId, candidate, 2, true, false);

    expect(isWorkspaceLifecycleLockHeldBy(workspaceId, candidate, 5_000)).toBe(false);
  });

  it("does not confirm ownership while another contender is still choosing", () => {
    stateDir = isolateStateDir();
    const workspaceId = `choosing-${process.pid}`;
    const chooser = "aaaaaaaa-choosing-ticket";
    const candidate = "zzzzzzzz-candidate-ticket";

    writeTicket(workspaceId, chooser, 0, false, true);
    writeTicket(workspaceId, candidate, 1, true, false);

    expect(isWorkspaceLifecycleLockHeldBy(workspaceId, candidate, 5_000)).toBe(false);
  });
});
