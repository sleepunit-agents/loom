import type { ReactNode } from 'react';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

export function ModuleCard({ title, description, action, toolbar, children }: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <CardTitle className="min-w-0 text-lg leading-snug [overflow-wrap:anywhere]">
          <h1 tabIndex={-1}>{title}</h1>
        </CardTitle>
        {description && <CardDescription className="[overflow-wrap:anywhere]">{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
        {toolbar && <div className="col-span-full">{toolbar}</div>}
      </CardHeader>
      <CardContent><div className="space-y-4">{children}</div></CardContent>
    </Card>
  );
}
