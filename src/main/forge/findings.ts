export interface ProbeFindings {
  shiftOptionKey: string | null
  modulesAs: 'name' | 'path'
  thumbRoute: boolean
}

// Defaults until the probe has been run against a real Forge instance.
export const FINDINGS: ProbeFindings = {
  shiftOptionKey: null,
  modulesAs: 'path',
  thumbRoute: false,
}
