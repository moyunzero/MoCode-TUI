import { useEffect } from "react";
import { useToast } from "../providers/toast";
import { formatSkillLoadToast, initSkillsOnSessionMount } from "../lib/skills/registry";

const SKILL_TOAST_DURATION_MS = 8_000;

/** Loads skills once at app boot and surfaces skip/disable toasts. */
export function SkillsInit() {
  const { show } = useToast();

  useEffect(() => {
    const { skills, collisions, loadError } = initSkillsOnSessionMount(process.cwd());
    if (loadError) {
      show({
        variant: skills.length > 0 ? "info" : "error",
        message: formatSkillLoadToast(loadError, skills.length > 0),
        duration: SKILL_TOAST_DURATION_MS,
      });
    }
    for (const name of collisions) {
      show({
        variant: "info",
        message: `Skill "${name}" skipped — conflicts with built-in /${name}`,
        duration: SKILL_TOAST_DURATION_MS,
      });
    }
  }, [show]);

  return null;
}
