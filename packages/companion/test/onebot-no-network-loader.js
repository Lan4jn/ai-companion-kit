export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws') return { url: 'data:text/javascript,export class WebSocket { on() {} }', shortCircuit: true };
  return nextResolve(specifier, context);
}
