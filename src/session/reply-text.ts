import { createHash } from "node:crypto";
import { assertReceiptIdentity, type ReceiptIdentity, type MemoryReplyObservation } from "./state.js";

/** Validate an observed assistant body; never infer completion from visibility alone. */
export function validateObservedReplyText(text: string, expected: ReceiptIdentity, state: string,
  reviewHead?: string, memory?: MemoryReplyObservation): string {
  if (!text.trim() || Buffer.byteLength(text, "utf8") > 256_000) throw new Error("OBSERVED_REPLY_TEXT_INVALID");
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const field = (name: string, required = true): string | undefined => {
    const values = lines.map(line => line.trim().replace(/\*\*|`/gu, ""))
      .filter(line => line.startsWith(`${name}:`)).map(line => line.slice(name.length + 1).trim());
    if (values.length !== 1 || !values[0]) {
      if (!required && values.length === 0) return undefined;
      throw new Error(`OBSERVED_REPLY_FIELD_INVALID: ${name}`);
    }
    return values[0];
  };
  const iteration = field("ITERATION")!;
  if (!/^(0|[1-9][0-9]*)$/u.test(iteration) || !Number.isSafeInteger(Number(iteration))) throw new Error("OBSERVED_REPLY_FIELD_INVALID: ITERATION");
  assertReceiptIdentity(expected, { taskId: field("TASK_ID")!, workspaceId: field("WORKSPACE_ID")!,
    messageId: field("MESSAGE_ID")!, iteration: Number(iteration) });
  if (field("STATE") !== state) throw new Error("OBSERVED_REPLY_STATE_MISMATCH");
  if (field("REVIEW_HEAD", false) !== reviewHead) throw new Error("OBSERVED_REPLY_REVIEW_HEAD_MISMATCH");
  if (memory) {
    if (field("MEMORY_PROJECT") !== memory.project || field("MEMORY_STATUS") !== memory.status.toUpperCase()) throw new Error("OBSERVED_REPLY_MEMORY_MISMATCH");
    const sources = field("MEMORY_SOURCES")!.split(",").map(source => source.trim());
    if (sources.some(source => !source) || new Set(sources).size !== sources.length ||
      new Set(memory.sources).size !== memory.sources.length || sources.length !== memory.sources.length ||
      !memory.sources.every(source => sources.includes(source)) ||
      field("MEMORY_REASON", memory.status === "degraded") !== memory.reason ||
      (memory.status === "ready" && memory.reason !== undefined)) throw new Error("OBSERVED_REPLY_MEMORY_MISMATCH");
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}
