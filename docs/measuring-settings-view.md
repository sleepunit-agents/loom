# Measuring approval presentation

Settings changes originate in chat through measuring.propose, which creates a durable before/after approval card. The shared Approvals tile and live inline card render MeasuringChange via renderMeasuringChange. Display parsing uses the same strict values and summary as the server, and never grants authority.

The card sends Allow/Deny through `approvals.answer`, the same command as every other approval card. Only a current household owner may answer; the operation and receipt commit together before the runtime refreshes. Agents may propose for themselves and read daily timings. There is no separate settings form or Measuring tile for a never-configured household.

The display shows all four persisted values, including retained settings while off and No local history for outside-only export. Loading, access loss or disconnect removes the containing card through the shared view snapshot.
