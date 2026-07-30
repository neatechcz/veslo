import process from "node:process";
import { fail } from "../attach-smoke.mjs";

export function assertMutationAuthorized(env = process.env) {
  if (env.WEBDRIVER_ALLOW_MUTATION !== "1") {
    fail("This command sends real prompts. Set WEBDRIVER_ALLOW_MUTATION=1 after choosing each target workspace.");
  }
}
