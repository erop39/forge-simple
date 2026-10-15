import { parseStats } from './stats'

test('parseStats keeps unavailable extension fields null', () => {
  expect(parseStats({ version: '1', cpu: { percent: 35 }, gpu: { utilization: 72, temperature: null } })).toMatchObject({
    version: '1', cpuPercent: 35, gpuUtilization: 72, gpuTemperature: null, gpuFanPercent: null,
    forgeVersion: null, ramUsed: null,
  })
  expect(parseStats({ cpu: { percent: -1 }, gpu: { power_watts: '100' } })).toMatchObject({
    cpuPercent: null, gpuPowerWatts: null,
  })
})
