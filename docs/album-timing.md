# Album timing

Album timing is recorded as structured `album_timing` events in Workers logs.
It is enabled by the code, with no database migration or new binding. Deploying
the change is required before real Telegram albums produce these records.

## Reading one album

Find its `photo_registered` event and use `batchId` to collect its queue runs,
slips, messages, and note answers. Join the initial webhook events using
`mediaGroupId` and `messageId`. `runId` groups a processing run; `itemId`
identifies a slip. A measured operation has matching start/end records with a
unique `spanId`. The end contains `durationMs` and `outcome`. All events have
an epoch-millisecond `atMs`, so work in separate invocations can be compared.

| Stage | Measurement |
| --- | --- |
| webhook_photo_received | Arrival after webhook authentication and JSON decoding; includes Telegram's coarse send time |
| photo_register | Database registration of the photo and pending work |
| queue_publish | Publishing the wakeup to the queue |
| queue_received | Time since publish started, plus the requested scheduling delay |
| job_claim | Database claim; job_not_claimed means this delivery did no processing |
| status_initial | Telegram accepting the initial reading message |
| photo_download | Telegram file lookup, download, and encoding |
| ocr | Typhoon OCR, including its internal retries |
| ocr_checkpoint | Persisting OCR text for reuse |
| nim_extract | NIM extraction and validation, including fallback/retry time |
| parsed_checkpoint | Persisting the extracted result |
| expense_save | Saving the expense and duplicate-handling receipt |
| summary_read | Reading the saved results for the summary |
| status_update | Telegram accepting a progress, note-request, or final summary |
| expense_card | Telegram accepting an expense card |
| shared_note_accept | Recording the user's shared note |
| individual_note_save | Recording one individual note and advancing its position |
| note_reply_to_next_prompt | Individual reply processing through the next question or completion |
| note_prompt | Telegram accepting an individual-note question |
| note_walk_finish | Closing the question and sending the completion message |
| job_checkpoint | Recording completion or the next retry |
| job / item | Entire processing run / slip attempt |

`attempt_started` identifies the attempt number and reused OCR/parsed results.
`attempt_failed` records handled failures: an `item` or `job` span can finish
successfully after handling a failed attempt. A start without an end can mean
interrupted work or incomplete log capture. Old queue messages without timing
metadata report null queue wait values.

## Full closed loop

- Captioned album: first webhook arrival to the last required card/summary
  delivery, across all runs. Check `run_result` for zero remaining work and
  a null retry time. A done summary can precede the final expense card.
- Shared note: first arrival to `status_delivered` with state `awaiting_note`,
  then `shared_note_received` to the final card/summary delivery. The gap
  between the note request and reply is user/Telegram waiting time.
- Individual notes: each `note_prompt_delivered` to its corresponding
  `individual_note_received` (same index) is user/Telegram waiting time.
  Bot response time is `note_reply_to_next_prompt`. The last
  `note_walk_complete` closes the note cycle. Skip/stop events also need to
  be considered when the user chooses those actions.

Compare epoch timestamps for total wall time. Do not sum nested spans or
concurrent slip durations: that double-counts elapsed time. Queue wait includes
the intentional delay and publish overhead; it is not purely queue congestion.
The server cannot measure the user's photo selection/upload time or when a
reply actually appears on their phone. Telegram's send timestamp has only
one-second resolution. Note timing starts when the album handler receives the
answer, after normal authentication/routing. These records cover the enabled
queued path; legacy album parsing is not instrumented end to end.

No note text, OCR text, amounts, bank details, or credentials are added to
timing records. Timing records use normal Workers log retention.

## Speed candidates to evaluate

1. If queue wait dominates, assess the single queue consumer and scheduling
   delays before changing them. More consumers increase provider load.
2. If one slip holds up each pair, consider independent slip jobs so a slow
   provider response does not delay starting the next slip.
3. If NIM dominates, benchmark the configured model order using real slips.
4. If saving an already-read album dominates, consider saving more than two
   parsed slips per run while retaining bounded Telegram message delivery.

These are candidates, not measured improvements. Concurrency, timeouts, model
selection, saving behavior, and production configuration are unchanged.
