import type { Context } from "hono";
export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  ASSETS: Fetcher;
  APP_ENV: string;
  APP_URL: string;
  SESSION_SECRET: string;
  BOOTSTRAP_SECRET?: string;
  SESSION_TTL: string;
  TIMEZONE: string;
}
export interface User {
  id: number;
  role: "ADMIN" | "MEDIADOR";
  username: string;
  dni: string | null;
  nombre: string;
  apellido: string;
  email: string;
  telefono: string;
  photo: string;
  active: number;
  password?: string | number[];
  created_at: string;
  updated_at: string;
  search_text?: string;
}
export interface Mediation {
  id: number;
  sede: string;
  date: string;
  start: string;
  m1: number;
  m2: number;
  title: string;
  case_number: string;
  state: string;
  result: string;
  created_at: string;
  updated_at: string;
  exported_at: string | null;
  export_id: number | null;
  version: number;
  name1?: string;
  name2?: string;
  dni1?: string;
  dni2?: string;
}
export interface News {
  id: number;
  title: string;
  content: string;
  image: string;
  published: number;
  publication_date: string;
  updated_at: string;
}
export type AppEnv = {
  Bindings: Env;
  Variables: {
    user: User | null;
    csrf: string;
    form: Record<string, string | File>;
    requestId: string;
    startedAt: number;
    logEntityId: number;
  };
};
export type Ctx = Context<AppEnv>;
export class BusinessError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export type SQLRow = Record<string, string | number | null>;
