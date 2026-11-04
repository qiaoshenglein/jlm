// 部署入口：Sites 边缘运行时（Deno）。业务逻辑全部在 api.mjs，本地与线上共用同一份代码。
import { createClient } from "npm:@supabase/supabase-js@2.57.4";
import { serveSite } from "./adapter.mjs";
import { handle } from "./api.mjs";

Deno.serve(serveSite(handle, {
  createClient,
  env: (name: string) => Deno.env.get(name),
}));
