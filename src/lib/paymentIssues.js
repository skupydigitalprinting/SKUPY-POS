export function retainUnresolvedPaymentIssues(issues, pending) {
  const unresolved = new Set(pending.map(item => item.invoiceNo))
  const entries = Object.entries(issues)
  const retained = entries.filter(([, issue]) => !issue.needsReconciliation || !issue.invoiceNo || unresolved.has(issue.invoiceNo))
  return retained.length === entries.length ? issues : Object.fromEntries(retained)
}
