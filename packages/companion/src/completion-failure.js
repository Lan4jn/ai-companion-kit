// Only fixed categories and validated HTTP status cross this boundary.
const categories = new Set(['http', 'timeout', 'cancelled', 'network', 'response_format', 'model_unavailable', 'unknown']);
export class CompletionFailure extends Error {
  constructor(category, status) {
    super('model completion failed');
    this.name = 'CompletionFailure';
    this.category = categories.has(category) ? category : 'unknown';
    if (this.category === 'http' && Number.isInteger(status) && status >= 400 && status <= 599) this.status = status;
  }
}
export function completionDiagnostic(error) {
  if (!(error instanceof CompletionFailure)) return null;
  const category = categories.has(error.category) ? error.category : 'unknown';
  return { category, ...(category === 'http' && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? { status: error.status } : {}) };
}
