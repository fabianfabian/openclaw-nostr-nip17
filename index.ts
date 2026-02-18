import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { nip17Plugin } from "./src/channel.js";
import { setNip17Runtime } from "./src/runtime.js";

const plugin = {
  id: "nostr-nip17",
  name: "Nostr (NIP-17)",
  description: "Nostr private DM channel plugin via NIP-17 gift-wrapped encryption",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setNip17Runtime(api.runtime);
    api.registerChannel({ plugin: nip17Plugin });
  },
};

export default plugin;
