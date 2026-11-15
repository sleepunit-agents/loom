import type { LiveRecord } from '../../data';
export interface Task extends LiveRecord {
  title: string; type: string; status: 'open' | 'in_progress' | 'closed'; priority: number;
  ready?: boolean; blocked?: boolean; assignee?: string; project?: string; parent?: string; dependsOn: string[];
  goal?: string; why?: string; doneWhen?: string; description?: string; ask?: string; ifYes?: string; ifNo?: string;
  createdAt: string; closedAt?: string; closeReason?: string; source?: string;
  comments: { actor: string; at: string; text: string }[];
}
