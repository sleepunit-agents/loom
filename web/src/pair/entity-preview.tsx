import type { ReactElement, ReactNode } from 'react';
import { useDataQuery } from '../data/graphql';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';
import type { Project } from './ticket-view';

export function EntityPreview({
  link,
  preview,
  intent,
}: {
  link: ReactElement;
  preview: ReactNode;
  intent: string;
}) {
  return (
    <HoverCard openDelay={350} closeDelay={120}>
      <HoverCardTrigger asChild aria-description={intent}>
        {link}
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        sideOffset={6}
        collisionPadding={12}
        className="w-72 max-w-[calc(100vw-1.5rem)] space-y-2 p-3"
      >
        {preview}
        <p className="text-xs text-muted-foreground">{intent}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

export function ProjectPreview({ id }: { id: string }) {
  const read = useDataQuery<{ project: Project | null }>(
    'query PairProjectPreview($id:String!){project:projectsSingle(where:{id:{eq:$id}}){id name goal lifecycle}}',
    { id },
  );
  const project = read.data?.project;
  return (
    <div className="space-y-1 [overflow-wrap:anywhere]">
      <div className="flex items-baseline justify-between gap-3">
        <strong className="font-semibold">{project?.name || id}</strong>
        {project?.lifecycle && <span className="text-xs text-muted-foreground">{project.lifecycle}</span>}
      </div>
      {project && <p className="line-clamp-3 text-card-body">{project.goal || "Tickets in progress and recent project activity."}</p>}
    </div>
  );
}
