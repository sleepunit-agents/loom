// The preview is extractive: every displayed finding retains the complete source
// note. Never turn an arbitrary pair of integers into a measurement.
export interface Note {
  seq: number;
  at: string;
  actor: string;
  text: string;
}
export function evidence(notes: readonly Note[]) {
  const recent = [...notes].sort((a, b) => b.seq - a.seq);
  const sentences = recent.flatMap((note) =>
    note.text.split(/(?<=[.!?])\s+|\n+/).map((text) => ({ note, text: text.trim() })),
  );
  const finding = sentences.find(({ text }) =>
    /\b(verified|confirmed|resolved|superseded|retracted)\b/i.test(text),
  );
  const measurement = sentences.flatMap(({ note, text }) => {
    const statistic = text.match(/\b(\d+(?:\.\d+)?)%[^.!?\n]{0,100}?\((\d+)\s*\/\s*(\d+)\)/);
    if (!statistic || +statistic[3] <= 0 || +statistic[2] > +statistic[3]) return [];
    return [{ note, text, numerator: statistic[2], denominator: statistic[3] }];
  })[0];
  const decision = sentences.find(({ text }) =>
    /\b(remains? (?:an? |the )?(?:open |separate )?(?:question|decision)|decision (?:pending|required)|still (?:need|requires?) (?:a |an? )?(?:ruling|decision))\b/i.test(
      text,
    ),
  );
  return { finding, measurement, decision };
}

export interface Finding {
  quote: string;
  note: Note;
}
export interface Review {
  question: string;
  findings: Finding[];
}
export function reviewRequest(id: string, latest: number) {
  return (
    'Review the decision evidence for ' +
    id +
    ' through note ' +
    latest +
    '. Read the current ticket and comments in Loom. ' +
    'Identify the unresolved decision and up to three distinct findings that bear on it, including evidence that supersedes older claims. ' +
    'For each finding, quote one exact continuous passage from a numbered ticket comment. Return JSON only in this shape: ' +
    '{"ticket":"' +
    id +
    '","through":' +
    latest +
    ',"question":"...","findings":[{"seq":1,"quote":"..."}]}. ' +
    'Keep this a read-only review.'
  );
}
// The model selects and interprets evidence. Only verbatim citations from the
// currently visible ticket can become cards. A new note invalidates the review.
export function readReview(words: string, id: string, notes: readonly Note[]): Review | null {
  try {
    const raw = JSON.parse(
      words
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, ''),
    );
    if (
      raw.ticket !== id ||
      raw.through !== Math.max(0, ...notes.map((n) => n.seq)) ||
      typeof raw.question !== 'string' ||
      !raw.question.trim() ||
      raw.question.length > 600 ||
      !Array.isArray(raw.findings) ||
      !raw.findings.length ||
      raw.findings.length > 3
    )
      return null;
    const findings: Finding[] = [];
    for (const item of raw.findings) {
      const note = notes.find((n) => n.seq === item?.seq);
      if (
        !note ||
        typeof item.quote !== 'string' ||
        item.quote.trim().length < 8 ||
        item.quote.length > 1500 ||
        !note.text.includes(item.quote)
      )
        return null;
      findings.push({ quote: item.quote, note });
    }
    return { question: raw.question, findings };
  } catch {
    return null;
  }
}
