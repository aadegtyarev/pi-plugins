/** Rejected review rounds allowed per task cycle before automatic continuation stops. */
export const REVIEW_REJECTION_LIMIT = 2;

const REVIEWER_NOTICE = /^Background task (?:completed|failed): \*\*reviewer\*\*/;
const REJECTED_VERDICT = /^#{1,3}\s*Review\b[^\n]*(?:\n\s*)*[^\n]*REQUEST_CHANGES/m;

type BranchEntry = {
  type?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown; toolName?: string; toolCallId?: string };
};

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
    .join("\n");
}

function reviewerCallIds(branch: readonly BranchEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of branch) {
    if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content as Array<Record<string, unknown>>) {
      const args = part?.arguments as Record<string, unknown> | undefined;
      if (part?.type === "toolCall" && part.name === "subagent" && typeof part.id === "string" && args?.agent === "reviewer" && args.action === undefined)
        ids.add(part.id);
    }
  }
  return ids;
}

/** Counts reviewer verdicts that requested changes on the given session branch. */
export function countReviewRejections(branch: readonly unknown[]): number {
  const entries = branch as readonly BranchEntry[];
  const reviewerCalls = reviewerCallIds(entries);
  let count = 0;
  for (const entry of entries) {
    let text = "";
    if (entry.type === "custom_message") {
      const content = textOf(entry.content);
      if (REVIEWER_NOTICE.test(content)) text = content;
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent" && reviewerCalls.has(entry.message.toolCallId ?? "")) {
      text = textOf(entry.message.content);
    }
    if (text && REJECTED_VERDICT.test(text)) count++;
  }
  return count;
}

export function reviewLimitReport(rejections: number): string {
  return [
    `The independent reviewer has rejected this work ${rejections} times (limit ${REVIEW_REJECTION_LIMIT}). Automatic continuation is stopped and the task is blocked.`,
    "Stop the review/fix loop now: do not start, resume, or steer workers or reviewers, and do not open or merge pull requests.",
    "Reply to the operator with a concise report: the outstanding reviewer findings, what each round fixed, the current branch/commit and check state, any background runs still active, and options (accept as is, keep fixing, or narrow scope).",
    "The operator continues the task with /task resume <answer>.",
  ].join("\n");
}
