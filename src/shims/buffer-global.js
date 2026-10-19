// Injected by esbuild (see esbuild.config.mjs): every bare `Buffer` in the bundle resolves to the
// npm polyfill, so isomorphic-git works on mobile where there is no global Buffer.
// The global itself is also filled in, for code that reaches Buffer through globalThis at run time
// (src/main.ts does the same, first thing; this covers module bodies that run before it).
import { Buffer } from "buffer";
if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;
export { Buffer };
