import { useState } from "react";
import type { ApprovalDto } from "../types";
import type { ChatActions } from "../hooks";
import { Icon } from "./icons";

/**
 * Approval modal. Information hierarchy: tool name → reason → parameters →
 * per-session allow → reject/allow. Decisions go through
 * `actions.approve(id, accept, allowSession)`.
 */
export function ApprovalModal({ approval, actions }: { approval: ApprovalDto | null; actions: ChatActions }) {
  const [allowSession, setAllowSession] = useState(false);

  if (!approval) return null;
  const args = JSON.stringify(approval.call.arguments, null, 2);
  const decide = (accept: boolean) => {
    void actions.approve(approval.approval_id, accept, allowSession);
    setAllowSession(false);
  };
  return (
    <div className="modal-backdrop">
      <div className="modal-card" role="dialog" aria-modal="true" aria-label="工具审批">
        <h3>需要审批</h3>
        <span className="approval-tool">
          <Icon name="build" size={13} />
          {approval.call.name}
        </span>
        <p className="approval-reason">{approval.reason}</p>
        {args ? (
          <div className="approval-call">
            <div className="dim">参数</div>
            <pre>{args}</pre>
          </div>
        ) : null}
        {approval.source_title ? (
          <p className="dim">来自子会话：{approval.source_title}</p>
        ) : null}
        <label className="approval-allow">
          <input
            type="checkbox"
            checked={allowSession}
            onChange={(e) => setAllowSession(e.target.checked)}
          />
          <span>仅本会话允许（不再重复询问该工具）</span>
        </label>
        <div className="approval-actions">
          <button type="button" className="danger" onClick={() => decide(false)}>
            拒绝
          </button>
          <button type="button" className="primary" onClick={() => decide(true)}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
