/** Shared by the fresh installation and the frozen schema-44 migration.
 * Source writes and checkpoints commit together, including bulk moves, imports, and retries. */
export const backlogCheckpointTriggers = [
  `CREATE TRIGGER task_backlog_baseline AFTER INSERT ON migrations WHEN NEW.number = 44 BEGIN
    INSERT INTO task_backlog_events(task,project,open,at) SELECT id,project,status <> 'closed',NEW.applied_at FROM tasks;
  END;`,
  `CREATE TRIGGER task_backlog_created AFTER INSERT ON tasks BEGIN
    INSERT INTO task_backlog_events(task,project,open,at) VALUES(NEW.id,NEW.project,NEW.status <> 'closed',loom_now());
  END;`,
  `CREATE TRIGGER task_backlog_changed AFTER UPDATE OF project,status ON tasks
    WHEN OLD.project IS NOT NEW.project OR (OLD.status = 'closed') <> (NEW.status = 'closed') BEGIN
    INSERT INTO task_backlog_events(task,project,open,at) VALUES(NEW.id,NEW.project,NEW.status <> 'closed',loom_now());
  END;`,
];
