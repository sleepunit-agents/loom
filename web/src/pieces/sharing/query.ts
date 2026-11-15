export interface SharingProject { id: string; name: string; members: string[]; agents: string[] }
export interface SharingChoices { members: string[]; agents: string[]; projects: SharingProject[] }
export interface SharingData { projectSharing: SharingChoices | null }
export const sharingQuery = `query ProjectSharing {
  projectSharing { members agents projects { id name members agents } }
}`;
