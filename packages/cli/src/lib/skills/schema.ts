import { z } from "zod";

export const skillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export type Skill = {
  name: string;
  description: string;
  body: string;
};
