import { execSync } from "node:child_process";

const isVercel = Boolean(process.env.VERCEL);
const command = isVercel
  ? "pnpm --dir services/veslo-share run build"
  : "pnpm --filter @neatech/veslo build";

execSync(command, { stdio: "inherit" });
