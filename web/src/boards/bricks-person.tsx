/** The `person` brick's body: the card of ./bricks-contact.tsx and, for a member, their open tickets. */
import { Assigned } from './assigned';
import { words, type BodyProps } from './brick-kit';
import { Contact } from './bricks-contact';

export function Person({ params, form }: BodyProps) {
  const [kind, id] = words(params.person).split(':');
  return <Contact slug={id} form={form} tickets={kind === 'member' ? <Assigned who={id} kind="member" form={form} /> : undefined} />;
}
