import { and, eq, getTableColumns, inArray } from 'drizzle-orm';
import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, type GraphQLFieldConfigMap } from 'graphql/index.js';
import type { DataDatabase } from '../../core/data/database.js';
import { projectRepositories, projects, tasks } from '../../core/data/schema.js';
import { taskVisibility } from '../../core/data/visibility.js';
import type { Viewer } from '../../policy.js';
import { repositoryKey } from '../changes/model.js';
import type { ProjectQueryReader } from './projects-query.js';

const text = new GraphQLNonNull(GraphQLString);
const contribution = new GraphQLObjectType({
  name: 'WorkProjectContribution',
  fields: {
    id: { type: text }, agent: { type: text }, name: { type: text },
    goal: { type: GraphQLString }, summary: { type: GraphQLString },
  },
});

export function projectContributionFields(db: DataDatabase, reader: ProjectQueryReader): GraphQLFieldConfigMap<unknown, {viewer: Viewer}> {
  return { workProjectContributions: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(contribution))),
    args: { project: { type: text } },
    resolve(_, {project}, {viewer}) {
      if (viewer.kind !== 'member' || !reader.cards) return [];
      const scope = taskVisibility(viewer);
      const visible = db.select({id: projects.id}).from(projects)
        .where(and(eq(projects.id, project), scope.projects!(getTableColumns(projects)))).get();
      if (!visible) return [];

      const cards = reader.cards(viewer);
      if (!cards.length) return [];
      const epicIds = [...new Set(cards.flatMap(({card}) => card.links.epic ? [card.links.epic] : []))];
      const epics = db.select({id: tasks.id, project: tasks.project}).from(tasks)
        .where(and(inArray(tasks.id, epicIds), eq(tasks.type, 'epic'), scope.tasks!(getTableColumns(tasks)))).all();
      const epicProjects = new Map(epics.map(epic => [epic.id, epic.project]));
      const repoProjects = new Map<string, Set<string>>();
      for (const binding of db.select().from(projectRepositories).all()) {
        const repo = repositoryKey(binding.repository);
        const owners = repoProjects.get(repo) ?? new Set<string>();
        owners.add(binding.project);
        repoProjects.set(repo, owners);
      }

      return cards.flatMap(({id, agent, card}) => {
        const matches = new Set<string>();
        if (card.links.epic) {
          const owner = epicProjects.get(card.links.epic);
          if (!owner) return [];
          matches.add(owner);
        }
        for (const repo of card.links.repos ?? []) {
          for (const owner of repoProjects.get(repositoryKey(repo)) ?? []) matches.add(owner);
        }
        // A shared slug or competing anchors cannot identify a household project.
        if (matches.size !== 1 || !matches.has(project)) return [];
        return [{id, agent, name: card.name, goal: card.goal, summary: card.summary}];
      });
    },
  }};
}
