import { readFileSync, statSync } from "node:fs";

/** Rejected review rounds allowed per task cycle before automatic continuation stops. */
export const REVIEW_REJECTION_LIMIT = 2;

// pi-subagents notify.ts: single, grouped ("Background tasks completed (2): **worker**, **reviewer**"), and detached completion notices.
const REVIEWER_NOTICE = /^(?:Background tasks? completed(?: \(\d+\))?|Detached foreground task completed):[^\n]*\*\*reviewer\*\*/;
const REVIEW_HEADING = /^#{1,3}[ \t]*[^\n]*\breview\b[^\n]*$/gim;
const VERDICT_WINDOW = 400;

type Verdict = "rejected" | "approved";

// pi-subagents' stock reviewer ends its review with "Merge verdict: BLOCK", "OK", or "OK with notes".
const MERGE_VERDICT = /^[ \t>*_-]*Merge verdict[*_]*:[*_\s]*(BLOCK|OK)\b/gim;
// pi-subagents replaces the tail of outputs longer than 2,000 characters with this reference to the full file.
const FULL_OUTPUT_REFERENCE = /^Full output: (\/.+?) \([^()\n]*\)\. Read it if needed\.$/m;
/** Custom session entry recording a verdict that was read from a full-output file. */
export const REVIEW_VERDICT_ENTRY = "pi-ad-task-review-verdict";
const MAX_FULL_OUTPUT_BYTES = 1024 * 1024;

/** The verdict of one reviewer result, or undefined when the text carries none (linear scan, no backtracking). */
export function verdictOf(text: string): Verdict | undefined {
  let merge: string | undefined;
  for (const match of text.matchAll(MERGE_VERDICT)) merge = match[1]!.toUpperCase();
  if (merge) return merge === "BLOCK" ? "rejected" : "approved";
  for (const heading of text.matchAll(REVIEW_HEADING)) {
    const window = text.slice(heading.index, heading.index + heading[0].length + VERDICT_WINDOW);
    const rejected = window.indexOf("REQUEST_CHANGES");
    const approved = window.indexOf("APPROVE");
    if (rejected >= 0 || approved >= 0) return rejected >= 0 && (approved < 0 || rejected < approved) ? "rejected" : "approved";
  }
  return undefined;
}

export type ReadFullOutput = (filePath: string) => string | undefined;

/** Reads a pi-subagents full-output file; anything unusual (missing, not a file, too large) yields undefined. */
export function readFullOutput(filePath: string): string | undefined {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FULL_OUTPUT_BYTES) return undefined;
    return readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/** Returns the reviewer result blocks of a notice: a grouped notice lists `N. <agent>` blocks; a single notice is one block. */
function reviewerBlocks(notice: string): string[] {
  if (!notice.startsWith("Background tasks completed (")) return [notice];
  const parts = notice.split(/^\d+\. ([\w.-]+)[^\n]*$/m);
  const blocks: string[] = [];
  for (let i = 1; i + 1 < parts.length; i += 2) if (parts[i] === "reviewer") blocks.push(parts[i + 1]!);
  return blocks;
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

export interface ReviewScan {
  rejections: number;
  /** Verdicts read from full-output files that the branch does not record yet. */
  discovered: Array<{ path: string; rejected: boolean }>;
}

/** Counts reviewer verdicts that requested changes on the given session branch. */
export function scanReviewVerdicts(branch: readonly unknown[], read: ReadFullOutput = readFullOutput): ReviewScan {
  const entries = branch as readonly BranchEntry[];
  const reviewerCalls = reviewerCallIds(entries);
  const recorded = new Map<string, boolean>();
  for (const entry of entries as ReadonlyArray<BranchEntry & { customType?: string; data?: { path?: unknown; rejected?: unknown } }>) {
    if (entry.type === "custom" && entry.customType === REVIEW_VERDICT_ENTRY && typeof entry.data?.path === "string" && typeof entry.data.rejected === "boolean")
      recorded.set(entry.data.path, entry.data.rejected);
  }
  const discovered: ReviewScan["discovered"] = [];
  const rejected = (text: string): boolean => {
    const verdict = verdictOf(text);
    if (verdict) return verdict === "rejected";
    const path = FULL_OUTPUT_REFERENCE.exec(text)?.[1];
    if (!path) return false;
    const known = recorded.get(path);
    if (known !== undefined) return known;
    const full = read(path);
    const fileVerdict = full === undefined ? undefined : verdictOf(full);
    if (!fileVerdict) return false;
    recorded.set(path, fileVerdict === "rejected");
    discovered.push({ path, rejected: fileVerdict === "rejected" });
    return fileVerdict === "rejected";
  };
  let rejections = 0;
  for (const entry of entries) {
    // At most one verdict per reviewer result, however many review headings it repeats.
    if (entry.type === "custom_message") {
      const content = textOf(entry.content);
      if (REVIEWER_NOTICE.test(content)) rejections += reviewerBlocks(content).filter(rejected).length;
    } else if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent" && reviewerCalls.has(entry.message.toolCallId ?? "")) {
      if (rejected(textOf(entry.message.content))) rejections++;
    }
  }
  return { rejections, discovered };
}

export function countReviewRejections(branch: readonly unknown[], read: ReadFullOutput = readFullOutput): number {
  return scanReviewVerdicts(branch, read).rejections;
}

export function reviewLimitReport(rejections: number): string {
  return [
    `The independent reviewer has rejected this work ${rejections} times (limit ${REVIEW_REJECTION_LIMIT}). Automatic continuation is stopped and the task is blocked.`,
    "Stop the review/fix loop now: do not start, resume, or steer workers or reviewers, and do not open or merge pull requests.",
    "Reply to the operator with a concise report: the outstanding reviewer findings, what each round fixed, the current branch/commit and check state, any background runs still active, and options (accept as is, keep fixing, or narrow scope).",
    "The operator continues the task with /task resume <answer>.",
  ].join("\n");
}
