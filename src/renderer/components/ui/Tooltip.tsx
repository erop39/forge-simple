import * as RadixTooltip from '@radix-ui/react-tooltip'
import type { ReactNode } from 'react'
import styles from './Tooltip.module.css'

type TooltipProps = { text: string; children: ReactNode }

export function Tooltip({ text, children }: TooltipProps) {
  return (
    <RadixTooltip.Provider delayDuration={400}>
      <RadixTooltip.Root>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal>
          <RadixTooltip.Content className={styles.content} sideOffset={6}>
            {text}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  )
}
