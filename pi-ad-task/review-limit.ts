/** Rejected review rounds allowed per task cycle before automatic continuation stops. */
export const REVIEW_REJECTION_LIMIT = 2;

// Single, batched ("Background tasks completed (2): **worker**, **reviewer**"), and detached completion notices.
const REVIEWER_NOTICE = /^(?:Background tasks? completed(?: \(\d+\))?|Detached foreground task completed):[^\n]*\*\*reviewer\*\*/;
const REVIEW_HEADING = /^#{1,3}[ \t]*[^\n]*\breview\b[^\n]*$/gim;
const VERDICT_WINDOW = 400;

/** Counts review headings whose first verdict token is REQUEST_CHANGES (linear scan, no backtracking). */
function rejectedVerdicts(text: string): number {
  let count = 0;
  for (const heading of text.matchAll(REVIEW_HEADING)) {
    const window = text.slice(heading.index, heading.index + heading[0].length + VERDICT_WINDOW);
    const rejected = window.indexOf("REQUEST_CHANGES");
    const approved = window.indexOf("APPROVE");
    if (rejected >= 0 && (approved < 0 || rejected < approved)) count++;
  }
  return count;
}

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
    if (text) count += rejectedVerdicts(text);
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
