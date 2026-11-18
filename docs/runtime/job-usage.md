# Reading job usage

The generated GraphQL query root exposes three reads. Each applies the caller’s current jobs visibility in SQL. A body working on a guest’s word receives an empty list or a null job. Program credentials retain their existing record allowlist.

- `jobUsage(id: String!)` returns one visible attempt, including its nullable `usage` and a list of `observations`. An unknown or hidden job returns null.
- `conversationJobUsage(conversation: String, from: String, to: String)` returns every matching visible attempt, newest queued first, with job ID breaking ties. A null conversation selects standalone jobs. Omitting the bounds includes the whole conversation.
- `jobUsageRollup(from: String!, to: String!, groupBy: String!, conversation: String)` groups visible attempts by `conversation`, `trigger`, `day` or `model`. Omitting conversation includes every conversation and standalone jobs. Passing null selects standalone jobs. Each group has a `key`, a `title`, the number of attempts (`jobCount`), the number carrying a retry link (`retryCount`), and its measured counters. The model key uses the reported model. Codex supplies the assignment's model, and an ended job without a report retains its assigned model. An unknown grouping value has a null key. The conversation title comes from its label.

Open **Job usage** in the launcher to see conversations ranked by reported tokens. The date inputs include both selected dates in the browser’s local time zone. Expand a conversation to see the attempts counted in that row.

GraphQL bounds are timestamps with a time zone. They select jobs by queue time, including the lower bound and excluding the upper. Day keys use UTC. A retry is a separate attempt even when it starts on a later day.

Each attempt can report `tokensIn`, `tokensOut`, `cacheRead`, `cacheWritten`, `modelCalls`, `toolCalls`, `largestContext`, elapsed milliseconds (`wallMs`), `harness`, `model` and `source`. The `tools` list contains name/count pairs. Null means unknown, and an empty list means the harness observed no tools. A terminal job without a report has source `none`; an unended job with no report has null usage. Rollups sum the available values of each additive counter. A counter with no measured values stays null. Largest context is the maximum measured input to one call. Total tokens is the sum of available input and output counts, including partial reports. Input already includes cached tokens.

Observations are calculated when read from visible jobs and current measurements.

- A job with a largest context of at least 32,768 tokens and an explicit zero tool-call count gets a large-context observation.
- An attempt with a retry link gets a retry observation.
- The newest trigger run gets a comparison on its last attempt when its positive token total is at least twice the median of earlier complete runs of that trigger. An even-sized baseline uses the mean of its middle values. A positive run qualifies against a zero median. Every visible attempt in a complete run must have ended and supplied both input and output. The comparison uses visible history beyond the requested time window. With no complete earlier run or an incomplete latest run, it produces no observation.

A run consists of the attempts for a trigger firing. A firing’s inbox reference identifies the trigger, and its delivery ID distinguishes repeated firings in a reused conversation. Retries belong to the same run even when mail moves to the retry. If a job takes several firings, the earliest trigger mail identifies its run, with mail ID breaking ties. Subsequent jobs in a wake conversation belong to the most recent identifiable firing. A historical wake with no firing mail groups by its trigger place and conversation. Ordinary sweep work has no trigger. A regular conversation attributes only attempts with firing mail in their retry family. Runs are ordered by the queue time of their first visible attempt.

For example, a conversation and its daily totals can be read over the same interval.

```graphql
query ConversationCost($id: String!, $from: String!, $to: String!) {
  conversationJobUsage(conversation: $id, from: $from, to: $to) {
    id title state retryOf queuedAt observations
    usage {
      source harness model totalTokens tokensIn tokensOut cacheRead cacheWritten
      wallMs largestContext modelCalls toolCalls tools { name count }
    }
  }
  jobUsageRollup(conversation: $id, from: $from, to: $to, groupBy: "day") {
    key jobCount retryCount totalTokens wallMs
  }
}
```

For one attempt, query `jobUsage(id: "job-…") { id observations usage { source totalTokens } }`. Sources are `report` for a structured harness report, `transcript` for observed stream events, and `none` when the harness supplies no counts.

### Submitting a report

A runtime client with a live job credential can post to `/api/conversation/usage` using the usual bearer and command envelope. The server derives the job from the credential. For example, a client that measured input and output can send:

```json
{"id":"report-1","input":{"source":"report","tokensIn":4288,"tokensOut":4}}
```

Omit unknown counters or send null. Send tool names and counts as a JSON object in `tools`. The first accepted report wins. A second distinct submission returns `saved: false`; reusing the original command ID and payload follows the normal receipt rules. When the job ends, its credential expires. The terminal record keeps claim-to-end elapsed time when both timestamps exist. Harness text, prompts, and tool arguments have no field in this report.
