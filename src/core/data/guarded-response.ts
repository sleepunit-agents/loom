/** Responses carrying private command data keep their authorization until the bytes are consumed. */
export function isGuardedCommandRead(name:string):boolean {
  return name==='conversation.session'||name==='tempo.readJournal'||name==='tempo.wakeLessons'||name==='tempo.wakeToolProfile'||name==='memory.noteFile';
}

const availability = new WeakMap<ReadableStream<Uint8Array>, () => boolean>();

/** Carry the exact execution lease into a trusted outer transport after it
 * consumes this response. An unguarded response has no lease. */
export function responseAvailability(response: Response): (() => boolean) | undefined {
  return response.body ? availability.get(response.body) : undefined;
}

/** Release bytes only while their execution remains current. Native Response
 * clones, including wrapped responses, retain the same lazy tee guards. */
export function guardedResponse(body:string,init:ResponseInit,available:()=>boolean):Response {
    const guardedStream = (): ReadableStream<Uint8Array> => {
    let buffered: string | undefined = body;
    // Zero buffering keeps the release check after every outer fetch/middleware
    // await. A response returned while allowed cannot retain readable words if
    // its consumer waits until permission or the word deadline has ended.
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        try {
          if (!available()) throw new Error('Data access ended');
          const bytes = new TextEncoder().encode(buffered); buffered = undefined;
          if (!available()) throw new Error('Data access ended');
          controller.enqueue(bytes); controller.close();
        } catch { buffered = undefined; controller.error(new Error('Data access ended')); }
      },
      cancel() { buffered = undefined; },
    }, { highWaterMark: 0 });
    // Response.clone() uses body.tee(), including after middleware wraps the
    // response. Preserve native Response/header semantics while keeping both
    // tee branches lazy and independently guarded at their first byte pull.
    stream.tee = () => {
      stream.getReader(); // Match native tee's locked original-stream contract.
      return [guardedStream(), guardedStream()];
    };
    availability.set(stream, available);
    return stream;
    };
    return new Response(guardedStream(), init);
}
