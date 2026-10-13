export const en = {
  'job.step': 'step {current}/{total}',

  'connection.connected': 'Connected',
  'connection.slow': 'Slow',
  'connection.reconnecting': 'Reconnecting',
  'connection.offline': 'Offline',
  'connection.latency': '{ms} ms',
  'connection.attempt': 'attempt {n}',

  'server.title': 'Forge server',
  'server.address': 'Server address',
  'server.placeholder': 'http://100.x.y.z:7860',
  'server.connect': 'Connect',
  'server.connecting': 'Connecting…',
  'server.hint': 'Start Forge with --api --listen.',
  'server.close': 'Close',

  'topbar.settings': 'Settings',
  'topbar.log': 'Activity log',

  'empty.noServer.title': 'Connect to your Forge',
  'empty.noServer.body': 'Enter the address of the PC that runs Forge Neo.',

  'notice.dismiss': 'Dismiss',

  // One entry per IpcErrorKey (src/shared/ipc.ts); the keys are the same strings.
  'error.noServer': 'Connect to a Forge server first.',
  'error.invalidParams': "Those settings aren't valid. Adjust them and try again.",
  'error.notFound': 'That item no longer exists. Refresh the view and try again.',
  'error.network': "Can't reach the server. Check the address and your VPN.",
  'error.notForge': "That address isn't a Forge API. Check the port.",
  'error.unexpected': 'Something went wrong. Try again.',
} as const
