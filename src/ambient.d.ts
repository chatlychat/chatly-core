/*
 * The only globals the core assumes besides the ES2022 standard library:
 * timers, which exist in every JS host a conversation can run in (browsers,
 * Node, Deno, Bun, workers, Unity/Unreal embedded runtimes with a timer
 * shim). Declared here because `tsconfig.src.json` loads no DOM and no Node
 * types on purpose; a name used in source that is not declared here fails the
 * typecheck, which is how a DOM leak is caught.
 */
declare function setTimeout(handler: () => void, ms?: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(handler: () => void, ms?: number): unknown;
declare function clearInterval(handle: unknown): void;
