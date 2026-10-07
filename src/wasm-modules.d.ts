/** `import mod from 'x.wasm?module'` yields a precompiled module on Cloudflare (@astrojs/cloudflare). */
declare module '*.wasm?module' {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
