import { Workspace } from "../workspace/manager.js";
import { readWorkspaceRouterForDiagnostics, RouterDiagnosticError } from "./state.js";

export interface WorkspaceRuntimeContext {
  workspace: Workspace;
  anchor: Workspace;
  router: boolean;
  workspaceRegistration: "registered" | "unregistered" | "revoked" | "legacy";
  errorClass?: "workspace_not_registered" | "workspace_revoked";
}

/** Resolve diagnostics without registering a workspace or granting it access. */
export function resolveWorkspaceRuntimeContext(root: string): WorkspaceRuntimeContext {
  const workspace = new Workspace(root);
  const router = readWorkspaceRouterForDiagnostics();
  if (!router) return { workspace, anchor: workspace, router: false, workspaceRegistration: "legacy" };

  const registration = router.workspaces.find(entry => entry.workspaceId === workspace.id);
  const workspaceRegistration = !registration ? "unregistered" : registration.revokedAt ? "revoked" : "registered";
  let anchor: Workspace;
  try { anchor = new Workspace(router.anchor.root); }
  catch { throw new RouterDiagnosticError("router_state_unavailable"); }
  if (anchor.id !== router.anchor.workspaceId) throw new RouterDiagnosticError("router_state_invalid");
  return {
    workspace,
    anchor,
    router: true,
    workspaceRegistration,
    ...(workspaceRegistration === "unregistered" ? { errorClass: "workspace_not_registered" as const }
      : workspaceRegistration === "revoked" ? { errorClass: "workspace_revoked" as const } : {}),
  };
}

export function runtimeContextSummary(context: WorkspaceRuntimeContext) {
  return {
    workspaceId: context.workspace.id,
    workspaceRoot: context.workspace.root,
    anchorWorkspaceId: context.anchor.id,
    anchorWorkspaceRoot: context.anchor.root,
    router: context.router,
    workspaceRegistration: context.workspaceRegistration,
    ...(context.errorClass ? { errorClass: context.errorClass } : {}),
  };
}
