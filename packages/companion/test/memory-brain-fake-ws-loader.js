export async function resolve(specifier, context, nextResolve) {
 if (specifier === 'ws') return {url:new URL('./memory-brain-fake-ws.js',import.meta.url).href, shortCircuit:true};
 return nextResolve(specifier,context);
}
