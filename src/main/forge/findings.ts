export interface ProbeFindings {
  /** Request field that carries the shift value; null when the server has none. */
  shiftField: 'distilled_cfg_scale' | null
  modulesAs: 'name' | 'path'
  thumbRoute: boolean
}

// Confirmed by the probe against a real Forge Neo server.
export const FINDINGS: ProbeFindings = {
  shiftField: 'distilled_cfg_scale',
  modulesAs: 'path',
  thumbRoute: true,
}
