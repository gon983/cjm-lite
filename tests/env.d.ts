/// <reference types="@cloudflare/vitest-plugin/types" />
import type { Env as AppBindings } from "../src/types";
import type { D1Migration } from "@cloudflare/vitest-plugin";
declare global {
  namespace Cloudflare {
    interface Env extends AppBindings {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
