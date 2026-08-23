import type { ApprovalDto } from "../types";
import type { ChatActions } from "../hooks";

export function ApprovalModal({ approval, actions }: { approval: ApprovalDto | null; actions: ChatActions }) {
  if (!approval) return null;
  const args = JSON.stringify(approval.call.arguments, null, 2);
  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <h3>需要审批</h3>
        <p className="approval-reason">{approval.reason}</p>
        <div className="approval-call">
          <code>{approval.call.name}</code>
          {args ? <pre>{args}</pre> : null}
        </div>
        {approval.source_title ? (
          <p className="dim">来自子会话：{approval.source_title}</p>
        ) : null}
        <div className="approval-actions">
          <button type="button" className="danger" onClick={() => void actions.approve(approval.approval_id, false)}>
            拒绝
          </button>
          <button type="button" className="primary" onClick={() => void actions.approve(approval.approval_id, true)}>
            允许
          </button>
        </div>
      </div>
    </div>
  );
}
