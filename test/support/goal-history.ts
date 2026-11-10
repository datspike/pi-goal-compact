import assert from "node:assert/strict";
import { readGoalHistory } from "../../src/goal/goal-projections.js";
import { isGoalProjectionEvent } from "../../src/goal/goal-projection-reducer.js";
import type { SessionEntryLike } from "../../src/goal/types.js";

/** Read preserved prose through the public history projection, including every continuation page. */
export function goalHistoryText(entries: Iterable<SessionEntryLike>, goalId: string): string {
  const branch = [...entries];
  const texts: string[] = [];
  let offset = 0;
  for (;;) {
    const index = readGoalHistory(branch, goalId, { offset, limit: 20 });
    for (const record of index.records ?? []) {
      let content = "", contentOffset = 0;
      for (;;) {
        const page = readGoalHistory(branch, goalId, { event_id: record.id, content_offset: contentOffset });
        content += page.content;
        if (page.nextContentOffset === null) break;
        contentOffset = page.nextContentOffset!;
      }
      const event: unknown = JSON.parse(content);
      assert.ok(isGoalProjectionEvent(event));
      if (event.kind === "documents_imported") texts.push(...event.documents.map(doc => doc.content));
      if (event.kind === "legacy_migrated") texts.push(event.decisions ?? "", event.paperCuts ?? "");
      if (event.kind === "decision_recorded") texts.push(event.entry.title, event.entry.decision, event.entry.rationale);
    }
    if (index.nextOffset === null) break;
    offset = index.nextOffset!;
  }
  return texts.join("\n");
}
