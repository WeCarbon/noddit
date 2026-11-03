export type GotoTerminalType = 'mac-iterm2' | 'mac-terminal'

/** Which locale key names the "go to session" menu item for this terminal kind. */
export function gotoSessionLabelKey(type: GotoTerminalType): 'ctxGotoSessionIterm2' | 'ctxGotoSessionTerminal' {
  return type === 'mac-iterm2' ? 'ctxGotoSessionIterm2' : 'ctxGotoSessionTerminal'
}

/** The bundle id NSWorkspace looks up to find that terminal app's own icon. */
export function gotoSessionBundleId(type: GotoTerminalType): string {
  return type === 'mac-iterm2' ? 'com.googlecode.iterm2' : 'com.apple.Terminal'
}
