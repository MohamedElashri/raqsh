---
name: raqsh-board
description: Plan work, update task cards and dependencies, and respond to feedback on a paired Raqsh board. Use when the user asks to work on a Raqsh board or review its queued feedback.
---

# Work with a Raqsh board

1. Inspect the pairing with `board_session_state`. Use `board_list` to find accessible boards and follow `nextOffset` until you find the requested board. Use `board_open` with its ID to inspect it. Ask the user which board to use if several match. If the tools or pairing are unavailable, ask the user to approve a pairing in Raqsh’s Agents panel.
2. Read the relevant cards and dependency edges with `board_get`. Use the same `semanticRevision` for all pages of a snapshot. Resolve task names to IDs on the selected board before writing.
3. Use `board_set_task_status` for a status-only change and `board_apply` for card and dependency edits. Use the latest semantic revision as `expectedRevision`. If a write is rejected because the revision changed, reread the affected items, preserve concurrent edits, and use a new operation ID for the revised request. If the reply is lost and the outcome is unknown, retry with the original operation ID and identical payload.

## Respond to board feedback

Read feedback for the selected board with `board_get_feedback`. Acknowledge an item you are taking up with `board_ack_feedback`, then use the returned `ackId` with `board_post_response` to record the result or a blocker. Keep the acknowledgment and response operation IDs distinct and stable on retries. Advance `after` only past items you have reviewed. Reuse the previous cursor after a lost reply.

When feedback asks you to work on a card, acknowledge it before starting. Set the card to done only after verifying the work, and summarize the outcome or blocker in the response.
