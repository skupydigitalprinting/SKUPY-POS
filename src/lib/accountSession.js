export function captureAccountSession(controller, auth) {
  const epoch = controller.getSnapshot().epoch
  const isCurrent = () => {
    const snapshot = controller.getSnapshot()
    return snapshot.phase === 'ready' && snapshot.epoch === epoch
  }
  return {
    getSession: () => auth.getSession(),
    isCurrent,
    onSessionEnd: () => { if (isCurrent()) return controller.signOut() },
  }
}
