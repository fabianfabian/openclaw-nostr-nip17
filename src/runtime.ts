import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setNip17Runtime(next: PluginRuntime): void {
  runtime = next;
}

export function getNip17Runtime(): PluginRuntime {
  if (!runtime) throw new Error("NIP-17 runtime not initialized");
  return runtime;
}
