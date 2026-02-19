import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

/** Per-account config (also doubles as top-level base config). */
export const Nip17AccountConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  privateKey: z.string().optional(),
  relays: z.array(z.string()).optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
});

export const Nip17ConfigSchema = Nip17AccountConfigSchema.extend({
  accounts: z.record(z.string(), Nip17AccountConfigSchema).optional(),
});

export type Nip17AccountConfig = z.infer<typeof Nip17AccountConfigSchema>;
export type Nip17Config = z.infer<typeof Nip17ConfigSchema>;
