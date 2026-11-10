/**
 * The Projects index's cards (docs/specs/projects.md, "The index"): what loom sends beside the index's page, and what
 * web/src/projects.tsx draws. Types only, so the web app can import them without the server's code.
 */
export interface CardPerson { name: string; person?: string; agent?: string }

export const NO_PROJECTS = 'No projects yet. A project is an ongoing body of work with a goal (a product, a client, a season); an agent makes one with project_write, and its page here collects everything filed under it.';

/** One project's card on the index (docs/specs/projects.md, "The index"), drawn by web/src/projects.tsx. */
export interface ProjectCardView {
  slug: string;
  name: string;
  /** The hub's page (projects/<agent>/<slug> in a household). */
  page: string;
  agent?: string;
  status: string;
  /** The summary's first sentence: what it is. */
  what?: string;
  /** Active projects only: what waits on the owner, or why it couldn't be counted. */
  waiting?: { count: number; items: string[] } | { unknown: string };
  lately: Array<{ text: string; ago: string; status?: string }>;
  /** Dated items a day over the last SPARK_DAYS days, oldest first; absent when there were none. */
  spark?: { days: number[]; label: string };
  /** The Changes piece's section, counted: "4 open · 1 failing". */
  changes?: { open: number; failing: number; running: number; line: string };
  repos: string[];
  people: CardPerson[];
  activity: string;
}
export interface ProjectCards { active: ProjectCardView[]; quiet: ProjectCardView[]; waiting: number }
