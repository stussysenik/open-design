// A closed Design Files tab is a persisted "do not scan my files" choice.
// The decision lives in ProjectTabsState, but file reads are issued from
// several components (ProjectView, FileViewer, DESIGN.md state, cover pipeline).
// This tiny registry is the single boundary they all share. It is keyed by
// project id so one opted-out project never affects another.

const deferredProjects = new Set<string>();

export function setFileLoadDeferred(projectId: string, deferred: boolean): void {
  if (deferred) deferredProjects.add(projectId);
  else deferredProjects.delete(projectId);
}

export function isFileLoadDeferred(projectId: string): boolean {
  return deferredProjects.has(projectId);
}
