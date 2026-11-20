/** Each role receives the original viewer and must enforce its own policy. All calls stay synchronous. */
import type {Viewer} from '../../core/index.js';
import type {ProjectCard,ProjectSection} from './projects-model.js';
export interface ProjectQuery {agent:string;card:ProjectCard;names:string[];notePrefixes:string[];conversations?:string[];since:string;now:number}
export type ProjectSectionRead = (query:ProjectQuery) => Omit<ProjectSection,'key'|'label'>;
export interface ProjectSectionRole {
 read(viewer:Viewer,query:ProjectQuery):ReturnType<ProjectSectionRead>;
 /** A listing can reuse this viewer's selection until the synchronous call returns. */
 prepareForList?(viewer:Viewer,active:ProjectQuery[]):ProjectSectionRead;
}
