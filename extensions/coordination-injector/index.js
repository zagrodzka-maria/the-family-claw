import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default function register(api) {
  api.on(
    "before_prompt_build",
    (event, ctx) => {
      const filePath = join(homedir(), ".openclaw", "shared", "COORDINATION.md");
      try {
        const content = readFileSync(filePath, "utf-8");
        if (content && content.trim()) {
          return {
            appendSystemContext: `\n\n<coordination-context file="COORDINATION.md">\n${content}\n</coordination-context>`,
          };
        }
      } catch {
        // File doesn't exist for this agent, skip silently
      }
    },
    { priority: 5 },
  );
}
