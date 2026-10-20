/** Shared quick-start prompts for the home screen and an empty session. */
export interface QuickStart {
  label: string;
  prompt: string;
}

export const QUICK_STARTS: QuickStart[] = [
  { label: "梳理仓库结构", prompt: "梳理这个仓库的模块结构，输出一份架构说明" },
  { label: "修复失败的测试", prompt: "运行测试，修复当前失败的用例并说明原因" },
  { label: "调研重试策略", prompt: "调研 Provider 的重试与降级策略，给出建议" },
];
