export class PromptQueue {
  private pending: Array<{ hookId: string; text: string }> = [];
  private pendingIds = new Set<string>();

  stage(hookId: string, text: string): void {
    if (this.pendingIds.has(hookId)) return;
    this.pendingIds.add(hookId);
    this.pending.push({ hookId, text });
  }

  consume(): string[] {
    const items = this.pending.map(item => item.text);
    this.clear();
    return items;
  }

  clear(): void {
    this.pending = [];
    this.pendingIds.clear();
  }
}
