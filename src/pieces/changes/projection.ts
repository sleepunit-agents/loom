import { attribute, type Attribution, type Change, type Project } from './model.js';
import { projectFor } from './importer.js';
/** Read and commit use the same current destination authority projection. */
export function projectChange(c:Change, projects?:Project[], attribution?:Attribution):Change {
 const value=attribution?attribute(c,attribution):{...c};
 if(projects){delete value.project;const project=projectFor(value.repo,projects);if(project)value.project=project;}
 return value;
}
