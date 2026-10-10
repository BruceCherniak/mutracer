// Import without browser globals to verify all relative ESM paths resolve.
// The optional oidn entry awaits an upstream oidn-web ESM fix.
const library = await import('../lib/main.js');
if (typeof library.Renderer !== 'function') throw new Error('Missing Renderer export');
console.log(`Library ESM resolves in Node (${Object.keys(library).length} exports).`);
