/**
 * Sampling speed in steps per second, taken between the first and the last sample.
 * Returns null when there are fewer than two samples, the step did not advance,
 * or no time passed between them.
 */
export function stepsPerSec(samples: readonly { t: number; step: number }[]): number | null {
  if (samples.length < 2) return null
  const first = samples[0]
  const last = samples[samples.length - 1]
  if (!first || !last) return null
  const steps = last.step - first.step
  const seconds = (last.t - first.t) / 1000
  if (steps <= 0 || seconds <= 0) return null
  return steps / seconds
}
