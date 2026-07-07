/**
 * Tool execution pipeline — hooks before approval, execute, after hooks (Phase 04, D-40).
 *
 * Order: beforeToolCall → approval gate → execute → afterToolCall.
 */

export type ToolPipelineToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

export type ToolPipelineGateResult = {
  allowed?: boolean;
  approved?: boolean;
  reason?: string;
};

export type RunToolPipelineParams = {
  toolCall: ToolPipelineToolCall;
  beforeHook: () => Promise<{ allowed: boolean; reason?: string }>;
  approvalGate: () => Promise<{ approved: boolean; reason?: string }>;
  executeTool: () => Promise<unknown>;
  afterHook: () => Promise<void>;
};

export type ToolPipelineResult = {
  blocked?: boolean;
  reason?: string;
  blockedBy?: "hook" | "approval";
};

/** Runs the D-40 tool pipeline; short-circuits when a beforeHook blocks. */
export async function runToolPipeline(
  params: RunToolPipelineParams,
): Promise<ToolPipelineResult> {
  const before = await params.beforeHook();
  if (!before.allowed) {
    return { blocked: true, reason: before.reason, blockedBy: "hook" };
  }

  const approval = await params.approvalGate();
  if (!approval.approved) {
    return { blocked: true, reason: approval.reason, blockedBy: "approval" };
  }

  await params.executeTool();
  await params.afterHook();
  return {};
}
