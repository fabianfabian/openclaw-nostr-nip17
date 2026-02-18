import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

export const Nip17ConfigSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  privateKey: z.string().optional(),
  relays: z.array(z.string()).optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
});

export type Nip17Config = z.infer<typeof Nip17ConfigSchema>;
